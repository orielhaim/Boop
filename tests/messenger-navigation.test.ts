import { expect, test } from "bun:test";
import { StackRouter } from "../node_modules/expo-router/build/react-navigation/routers/StackRouter";
import { isActionHandled } from "../node_modules/expo-router/build/react-navigation/routers/utils";
import { getInitialDestinationMeasurementSignal } from "../node_modules/react-native-screen-transitions/src/components/boundary/utils/destination-signals";
import { chatStackRouter } from "../src/components/navigation/chat-stack-router";

test("a quick return from the inbox cannot reactivate the chat that is still closing", () => {
  const router = StackRouter({ initialRouteName: "(tabs)" });
  const config = {
    routeNames: ["(tabs)", "chat/[key]", "person/[key]"],
    routeGetIdList: {},
  };
  const getStateForAction = chatStackRouter(router).getStateForAction;
  if (!getStateForAction) throw new Error("Missing messenger router override");

  let state: Parameters<typeof getStateForAction>[0] = {
    key: "messenger",
    routeKeySeq: 0,
    index: 0,
    routeNames: config.routeNames,
    routes: [{ key: "tabs", name: "(tabs)" }],
    stale: false,
    type: "stack",
  };
  const dispatch = (action: Parameters<typeof getStateForAction>[1]) => {
    const result = getStateForAction(state, action, config);
    if (!isActionHandled(result)) throw new Error("Action was not handled");
    state = result.state;
    return result.affectedRouteKey;
  };

  const chat = { name: "chat/[key]", params: { key: "marmot-ab" } };
  const profile = {
    name: "person/[key]",
    params: { key: "peer", profileMorph: "person:peer" },
  };
  const warmed = dispatch({ type: "PRELOAD", payload: chat });
  expect(
    dispatch({
      type: "PRELOAD",
      payload: { ...chat, params: { key: "marmot-cd" } },
    }),
  ).toBe(warmed);
  expect(dispatch({ type: "PUSH", payload: chat })).toBe(warmed);
  dispatch({ type: "PUSH", payload: profile });
  expect(dispatch({ type: "POP", payload: { count: 1 } })).toBe(warmed);
  dispatch({ type: "POP", payload: { count: 1 } });
  const reopened = dispatch({ type: "PUSH", payload: chat });
  expect(reopened).not.toBe(warmed);
  expect(state.routes[state.index]).toMatchObject(chat);
});

test("a profile boundary releases its gate when opening has already advanced", () => {
  const measurement = {
    enabled: true,
    linkId: "profile-morph-person-peer-avatar",
    destinationPresent: false,
    sourcePresent: true,
    canWaitForMeasurement: true,
  };
  expect(getInitialDestinationMeasurementSignal(measurement)?.action).toBe(
    "wait",
  );

  const afterOpenStarts = { ...measurement, canWaitForMeasurement: false };
  expect(getInitialDestinationMeasurementSignal(afterOpenStarts)?.action).toBe(
    "release",
  );
});
