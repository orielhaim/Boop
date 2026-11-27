use std::future::Future;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::num::NonZeroUsize;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use futures::stream::SplitSink;
use futures::{Sink, SinkExt, StreamExt};
use nostr::prelude::{Event, Filter};
use nostr::types::Url;
use nostr_sdk::client::Client;
use nostr_sdk::error::Error;

use async_wsocket::Message;
use nostr_sdk::transport::websocket::{WebSocketSink, WebSocketStream, WebSocketTransport};
use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use tokio_tungstenite::tungstenite::Message as NativeMessage;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream as TungsteniteStream, client_async_tls_with_config,
};

use crate::SocialError;
use crate::config::MAX_EVENT_BYTES;
use crate::host::AccountSigner;
use crate::runtime::Operation;

fn admitted_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !matches!(a, 0 | 10 | 127 | 224..=255)
                && !matches!(
                    (a, b),
                    (100, 64..=127) | (169, 254) | (172, 16..=31) | (192, 168) | (198, 18..=19)
                )
                && !matches!(
                    (a, b, c),
                    (192, 0, 0 | 2) | (192, 88, 99) | (198, 51, 100) | (203, 0, 113)
                )
        }
        IpAddr::V6(ip) => {
            let [a, b, ..] = ip.segments();
            (0x2000..=0x3fff).contains(&a)
                && !(a == 0x2001 && (b < 0x0200 || b == 0x0db8))
                && a != 0x2002
                && a != 0x3fff
        }
    }
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    }
}

fn validate_address(url: &Url, allow_loopback: bool) -> Result<(), SocialError> {
    if !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.host().is_none()
    {
        return Err(SocialError::UnsafeRelay);
    }
    if url.scheme() == "ws" && allow_loopback && is_loopback(url) {
        return Ok(());
    }
    if url.scheme() != "wss" {
        return Err(SocialError::UnsafeRelay);
    }
    match url.host() {
        Some(url::Host::Ipv4(ip)) if !admitted_ip(ip.into()) => Err(SocialError::UnsafeRelay),
        Some(url::Host::Ipv6(ip)) if !admitted_ip(ip.into()) => Err(SocialError::UnsafeRelay),
        Some(url::Host::Domain(domain))
            if !domain.contains('.')
                || domain
                    .trim_end_matches('.')
                    .to_ascii_lowercase()
                    .ends_with(".localhost") =>
        {
            Err(SocialError::UnsafeRelay)
        }
        _ => Ok(()),
    }
}

#[derive(Debug)]
struct CheckedTransport {
    address: SocketAddr,
    operation: Operation,
}

impl WebSocketTransport for CheckedTransport {
    fn support_ping(&self) -> bool {
        true
    }

    fn connect<'a>(
        &'a self,
        url: &'a Url,
        _proxy: Option<SocketAddr>,
    ) -> Pin<Box<dyn Future<Output = Result<(WebSocketSink, WebSocketStream), Error>> + Send + 'a>>
    {
        Box::pin(async move {
            self.operation.check().map_err(Error::transport)?;
            let tcp = TcpStream::connect(self.address)
                .await
                .map_err(Error::transport)?;
            let config = WebSocketConfig::default()
                .max_message_size(Some(MAX_EVENT_BYTES * 2))
                .max_frame_size(Some(MAX_EVENT_BYTES * 2))
                .max_write_buffer_size(MAX_EVENT_BYTES * 8);
            let (socket, _) = Box::pin(client_async_tls_with_config(
                url.as_str(),
                tcp,
                Some(config),
                None,
            ))
            .await
            .map_err(Error::transport)?;
            self.operation.check().map_err(Error::transport)?;
            let (sink, stream) = socket.split();
            Ok((
                Box::pin(CheckedSink {
                    sink,
                    operation: self.operation.clone(),
                }) as WebSocketSink,
                Box::pin(stream.map(native_message)) as WebSocketStream,
            ))
        })
    }
}

struct CheckedSink {
    sink: SplitSink<TungsteniteStream<MaybeTlsStream<TcpStream>>, NativeMessage>,
    operation: Operation,
}

impl Sink<Message> for CheckedSink {
    type Error = Error;

    fn poll_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
        self.operation.check().map_err(Error::transport)?;
        self.sink.poll_ready_unpin(cx).map_err(Error::transport)
    }

    fn start_send(mut self: Pin<&mut Self>, frame: Message) -> Result<(), Error> {
        self.operation.check().map_err(Error::transport)?;
        self.sink
            .start_send_unpin(frame.into())
            .map_err(Error::transport)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
        self.operation.check().map_err(Error::transport)?;
        self.sink.poll_flush_unpin(cx).map_err(Error::transport)
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
        self.operation.check().map_err(Error::transport)?;
        self.sink.poll_close_unpin(cx).map_err(Error::transport)
    }
}

fn native_message(
    frame: Result<NativeMessage, tokio_tungstenite::tungstenite::Error>,
) -> Result<Message, Error> {
    Ok(match frame.map_err(Error::transport)? {
        NativeMessage::Text(text) => Message::Text(text.to_string()),
        NativeMessage::Binary(bytes) => Message::Binary(bytes.to_vec()),
        NativeMessage::Ping(bytes) => Message::Ping(bytes.to_vec()),
        NativeMessage::Pong(bytes) => Message::Pong(bytes.to_vec()),
        NativeMessage::Close(frame) => Message::Close(frame.map(Into::into)),
        // Tungstenite only returns decoded messages from its stream.
        NativeMessage::Frame(_) => {
            return Err(Error::transport(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unexpected WebSocket frame",
            )));
        }
    })
}

pub(crate) struct RelayEndpoint(Url);

impl RelayEndpoint {
    pub(crate) fn parse(input: &str, allow_loopback: bool) -> Result<Self, SocialError> {
        if input.len() > 2048 {
            return Err(SocialError::UnsafeRelay);
        }
        let url = Url::parse(input).map_err(|_| SocialError::UnsafeRelay)?;
        validate_address(&url, allow_loopback)?;
        Ok(Self(url))
    }

    async fn resolve(
        &self,
        dns: Arc<Semaphore>,
        operation: &Operation,
    ) -> Result<SocketAddr, SocialError> {
        let url = &self.0;
        let host = url.host_str().ok_or(SocialError::UnsafeRelay)?;
        let host = host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned();
        let port = url
            .port_or_known_default()
            .ok_or(SocialError::UnsafeRelay)?;
        let loopback = is_loopback(url);
        operation.check()?;
        // Retain the permit in libc resolution even if the operation stops waiting for it.
        let permit = dns.try_acquire_owned().map_err(|_| SocialError::Busy)?;
        operation
            .wait(async {
                tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    let mut addresses = (host.as_str(), port)
                        .to_socket_addrs()
                        .map_err(|_| SocialError::Relay)?;
                    addresses
                        .find(|address| {
                            admitted_ip(address.ip()) || (loopback && address.ip().is_loopback())
                        })
                        .ok_or(SocialError::UnsafeRelay)
                })
                .await
                .map_err(|_| SocialError::Runtime)?
            })
            .await
    }
}

pub(crate) async fn publish_and_read(
    endpoint: RelayEndpoint,
    dns: Arc<Semaphore>,
    event: &Event,
    signer: &AccountSigner,
    operation: &Operation,
) -> Result<Event, SocialError> {
    let address = endpoint.resolve(dns, operation).await?;
    let url = endpoint.0;
    // Connect only to the checked address. The original hostname remains the TLS name and Host header.
    let client = Client::builder()
        .max_relays(NonZeroUsize::new(1))
        .verify_subscriptions(true)
        .websocket_transport(CheckedTransport {
            address,
            operation: operation.clone(),
        })
        .build();
    let result = operation
        .wait(async {
            client
                .add_relay(url.as_str())
                .await
                .map_err(|_| SocialError::Relay)?;
            client
                .try_connect_relay(url.as_str(), Duration::from_secs(5))
                .await
                .map_err(|_| SocialError::Relay)?;
            signer.authorize().await?;
            operation.check()?;
            let relay = client
                .relay(url.as_str())
                .await
                .map_err(|_| SocialError::Relay)?
                .ok_or(SocialError::Relay)?;
            signer.authorize().await?;
            operation.check()?;
            let reply = relay
                .send_event(event)
                .wait_for_ok(true)
                .await
                .map_err(|_| SocialError::Relay)?;
            if !reply.status().is_ack() {
                return Err(SocialError::Relay);
            }
            relay
                .fetch_events(Filter::new().id(event.id).limit(1))
                .max_events(1)
                .timeout(Duration::from_secs(5))
                .await
                .map_err(|_| SocialError::Relay)?
                .into_iter()
                .find(|received| received.id == event.id)
                .ok_or(SocialError::Relay)
        })
        .await;
    client.shutdown().await;
    result
}
