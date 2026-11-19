CREATE TABLE `blocked_identities` (
	`public_key` text PRIMARY KEY NOT NULL,
	`blocked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `communication_grants` (
	`public_key` text PRIMARY KEY NOT NULL,
	`initiated` integer DEFAULT false NOT NULL,
	`approved` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message_requests` (
	`public_key` text PRIMARY KEY NOT NULL,
	`received_at` integer NOT NULL,
	`declined_through` integer DEFAULT 0 NOT NULL,
	`message` text
);
--> statement-breakpoint
INSERT INTO communication_grants (public_key, initiated)
SELECT peer_key, 1 FROM messages WHERE direction = 'outgoing' AND status = 'sent'
UNION SELECT peer_key, 1 FROM call_history WHERE direction = 'outgoing' AND answered_at IS NOT NULL AND outcome IN ('completed', 'answered', 'remote-disconnected');
--> statement-breakpoint
CREATE TRIGGER grant_on_message_delivery AFTER UPDATE OF status ON messages
WHEN NEW.direction = 'outgoing' AND NEW.status = 'sent' AND OLD.status <> 'sent'
BEGIN
  INSERT INTO communication_grants (public_key, initiated) VALUES (NEW.peer_key, 1)
  ON CONFLICT(public_key) DO UPDATE SET initiated = 1;
END;
