import { PermissionsAndroid } from "react-native";

export function hasMicrophonePermission() {
  return PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
}

export async function askForMicrophone() {
  return (
    (await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    )) === PermissionsAndroid.RESULTS.GRANTED
  );
}

export async function allowBluetoothOutput() {
  return (
    (await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    )) === PermissionsAndroid.RESULTS.GRANTED
  );
}

export function hasBluetoothOutputPermission() {
  return PermissionsAndroid.check(
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
  );
}
