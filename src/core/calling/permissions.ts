export async function hasMicrophonePermission() {
  // iOS WebRTC requests microphone access when opening the device.
  return true;
}

export async function askForMicrophone() {
  return true;
}

export async function allowBluetoothOutput() {
  return false;
}

export async function hasBluetoothOutputPermission() {
  return false;
}
