export const devicesEn = {
  title: "Devices",
  category: "Linked devices and sign-in security",
  attentionCount: "Security items to review: {{count}}",
  hero: "Your account, across devices",
  heroHelp:
    "Use Boop on another installation. Compare a private code on both screens to establish trust.",
  link: "Link a device",
  current: "This device",
  currentLocal: "Signed in on this installation",
  localOnly: "You haven’t linked another device yet.",
  localAccount: "Account on this device",
  signOut: "Sign out on this device",
  done: "Done",
  lifecycleSigningOut: "Signing out this device…",
  lifecycleRemoving: "Removing this device…",
  lifecycleKeyPackagesDeleted: "Key packages removed: {{count}}.",
  lifecycleKeyPackageFailures:
    "Key package removals that need attention: {{count}}.",
  lifecycleGroupFailures: "Group departures that need attention: {{count}}.",
  lifecycleGroupsLeft: "Group departures completed: {{count}}.",
  lifecycleGroupsLeftToSiblings: "Groups left to other devices: {{count}}.",
  lifecycleSiblingsNotReached:
    "Some other linked devices could not be notified.",
  lifecycleLocalCleanupComplete:
    "This device’s local sign-in data was cleared.",
  lifecycleLocalCleanupFailed:
    "Local cleanup did not finish. Keep this screen open and retry.",
  lifecycleAccountRemoved:
    "The account and its Boop data were removed from this device.",
  signOutHelp:
    "Boop keeps the local account for signing back in and asks relays to delete this installation’s key packages. Other devices may continue to use the account.",
  wipe: "Remove account from this device",
  wipeHelp:
    "Boop will coordinate departure where possible, then remove the account, local conversations and retained media here. Other installations may continue using the account.",
  others: "Other linked devices",
  noOthers: "No other devices are linked.",
  unknownDevice: "Unnamed device",
  unknownClient: "Unknown application",
  active: "Active",
  inactive: "Inactive",
  leaving: "Leaving",
  moved: "Moved",
  unknown: "Status unavailable",
  lastSeen: "Last reported {{date}}",
  lastUnknown: "No activity reported",
  linkedOn: "Linked {{date}}",
  linkedBy: "Linked by {{name}}",
  onDeviceInactive: "This installation assesses the device as inactive",
  pending: "Removal pending",
  requested: "Removal requested",
  removed: "Removed from the trusted group",
  failed: "Removal failed",
  unavailable: "Couldn’t verify removal",
  remove: "Remove device",
  removeOthers: "Remove all other devices",
  removeHelp:
    "This requests removal from your trusted device group and chats. A copied account key can still sign as you, and any plaintext already saved elsewhere can remain there.",
  deviceSettings: "Device preferences",
  rename: "Edit device name",
  name: "Device name",
  nameHelp: "Use up to 64 UTF-8 bytes. An empty name clears the label.",
  invalidName: "Enter a name of up to 64 UTF-8 bytes.",
  nameTooLong: "The name exceeds 64 UTF-8 bytes.",
  save: "Save changes",
  addChats: "Add to all chats",
  addChatsHelp:
    "Include this device in eligible conversations. Turning this off keeps the chats it already joined.",
  history: "Bring chat history",
  historyHelp:
    "Allow eligible future history and transfers still owed. Earlier chats may have no history to import.",
  keep: "Keep while inactive",
  keepHelp:
    "Prevent automatic removal for inactivity. You can still remove the device.",
  inactivity: "Inactive devices",
  inactivityHelp:
    "Boop can mark eligible devices inactive after about 30 days and remove them after about 90. Timing depends on synchronization and may restart after a long interruption.",
  security: "Account security",
  review: "Review activity",
  signIns: "Unrecognized sign-ins",
  noSignIns: "There are no sign-ins to review in the latest device data.",
  check: "Check for sign-ins",
  checkingSignIns: "Checking for sign-ins…",
  staleSignIns:
    "Showing previously loaded sign-in information while this check refreshes.",
  checkFailed:
    "Boop couldn’t finish checking for other sign-ins. Check your connection and try again.",
  signInNew: "Was this sign-in you?",
  signInOlder: "Do you still have this earlier installation?",
  signedIn: "Key package reported",
  signedOut: "Key package no longer reported",
  reportedClient: "Reported application: {{name}}",
  firstSeen: "First reported {{date}}",
  signInHelp:
    "Your account key was used to publish a key package. The reported application can’t identify a physical device.",
  knownBefore:
    "A device using this slot was previously linked here. Verify any new link on both screens.",
  wasMe: "This was me",
  wasMeHelp:
    "On that installation, open Boop and choose Link a device. Compare both screens when a request appears here.",
  notMe: "This wasn’t me",
  reject: "Reject sign-in",
  rejectHelp:
    "Boop records your decision in the trusted device group when possible. Anyone holding a copy of the account key can still sign as you.",
  notNow: "Not now",
  deferred: "Saved for later",
  linkedElsewhere: "Linked by another device",
  rejectedElsewhere: "Rejected by another device",
  signInChanged:
    "The sign-in has changed. Return to the list and review its latest status.",
  dismiss: "Dismiss",
  warning: "Possible account-key compromise",
  warningHelp:
    "Boop detected activity that may mean someone else can sign with your account key. Check linked devices and sign-ins. If your key may be exposed, prepare a new identity and share its address with your contacts.",
  warningRejected: "Activity from a rejected sign-in",
  warningForeign: "Unexpected publication for this device slot",
  warningUnknown: "Unexpected account activity",
  warningAcknowledge: "Acknowledge on this device",
  warningAcknowledgeHelp:
    "Acknowledgment clears this warning here. It does not change who can use your account key.",
  requests: "Link requests",
  request: "Review link request",
  resumeLink: "Resume linking",
  compare: "Compare both screens",
  compareHelp:
    "Make sure all seven emoji match in the same order. Confirm only if both screens show the same code.",
  match: "They match",
  mismatch: "The codes differ",
  waitForAnswer: "Open Boop on a linked device",
  waitForAnswerHelp:
    "Use a device already signed in to this identity. Open Devices and look for a link request.",
  waitForOther: "Waiting for the other device to confirm",
  preparing: "Preparing your comparison code",
  joining: "Joining the trusted device group",
  linking: "Waiting for the new device to finish linking",
  linked: "Device linked",
  linkedHelp:
    "You can leave this screen while eligible conversations and history arrive.",
  addedElsewhere: "{{device}} was added by {{other}}",
  competingRequests:
    "Several requests arrived together. Continue with one new installation at a time.",
  rateLimited: "Too many link requests. Try again after {{date}}.",
  cannotLink: "The other installation doesn’t support this device group.",
  tooManyDevices:
    "The group has reached its 20-device limit. Remove a linked device before trying again.",
  cancelled: "Linking was canceled here.",
  cancelledElsewhere: "The other device canceled or chose Not now.",
  codesDiffer: "The comparison codes did not match.",
  verificationFailed:
    "Boop could not verify this link. Begin a new comparison.",
  timedOut: "The code expired. Start again to compare a new code.",
  answeredElsewhere: "Another device is handling this request.",
  rejected: "A device rejected this sign-in.",
  linkFailed:
    "The link could not finish. Check the device roster before trying again.",
  pairingChanged:
    "The request has changed. Review the current code on both screens.",
  linkPending:
    "This device is still finishing its link. Try again after the roster updates.",
  cancelLink: "Cancel link",
  cancelLinkHelp:
    "Boop will cancel the current comparison. A link already admitted by the device group can continue settling.",
  retry: "Try again",
  available: "Ready to link",
  linkFromNewDevice:
    "Open Devices on the installation you want to add and start linking there. You can approve its request on this device.",
  startHere: "This is the new device",
  operationFailed:
    "Boop couldn’t complete this action. Check the latest status and try again.",
  groupBusy:
    "The device group is finishing an earlier change. Try again shortly.",
  loading: "Reading the device group…",
  reconnecting: "Reconnecting to device security…",
  paused: "Device updates are paused",
  pausedHelp:
    "Chats are disconnected. You can review previously loaded device information or manage the account on this device. Connect Chats to refresh or link devices.",
  recoveryCatchingUp: "Recovering history in {{count}} conversations",
  recoveryInbox: "Checking for conversation invitations",
  recoveryIncomplete:
    "Boop couldn’t recover all available history in {{count}} places.",
  unreadable: "Some device information couldn’t be read.",
  sync: "Conversation sync",
  syncingNew: "Joined {{done}} of {{total}} eligible conversations",
  syncingOther:
    "Added the new device to {{done}} of {{total}} eligible conversations",
  noProgress: "Conversation joining progress is unavailable.",
  historyReceiving: "Receiving history",
  historyRetrying: "Retrying history import",
  historyImported: "History imported {{date}}",
  historyFrom: "From {{name}}",
  noHistory: "No history transfers are reported.",
  closedChats: "Conversations that can’t take another linked device: {{count}}",
  leftoverChats: "Conversations that still include a removed device: {{count}}",
  leftoverHelp:
    "Ask a group admin to review its membership. Removing an account member can also remove their other devices.",
  recovery: "Device connection and recovery",
  backup: "Encrypted backup and restore",
  backupHelp: "Restore from a backup using its recovery words.",
  stalled: "This device can’t catch up with its trusted device group.",
  keyHealth:
    "Your linked devices are preventing this device from refreshing the keys used to receive invitations.",
  repair: "Repair device connection",
  rotate: "Refresh invitation keys",
  rotateHelp:
    "Publish a new key package for this installation. Use this if repair could not finish refreshing its keys.",
  repairHelp:
    "Boop discards this installation’s trusted group copy, keeps your account and chats, then rotates its key package and starts a fresh comparison. You’ll need a device to link with. Canceling the new comparison can leave this device without its previous trust.",
  move: "Link to another device group",
  moveHelp:
    "Only this installation moves. Other devices stay in their current group.",
  waitingForWelcome: "Waiting to join the new device group",
  moveJoining: "Joining the new device group",
  made: "This installation moved to the new group",
  moveFailed: "This installation couldn’t move to the new group",
  oldSibling: "Previously linked device: {{name}}",
  discovery: "Connect your previous devices",
  discoveryHelp:
    "If you already use this identity elsewhere, link a device to receive eligible conversations and history.",
  discoveryEmpty:
    "This check didn’t find another sign-in. You can link an installation later in Devices.",
  startFresh: "Start fresh",
  startFreshHelp:
    "Boop will defer earlier sign-ins. Those devices can still link to this one later.",
  continueAlone: "Continue without linking",
  continueAloneHelp:
    "You can link later in Devices. Old conversations haven’t been restored.",
  startedFresh:
    "This installation started fresh. Conversations arrive through new invitations or later linking.",
  groupSupport: "Account devices",
  groupEnable: "Allow linked devices in this group",
  groupEnableHelp:
    "Eligible devices of the same account can join and leave through the other devices of that account. This change can’t be undone.",
  notAdmin: "A group admin can turn this on.",
  alreadyEnabled: "Linked devices are supported in this group.",
  legacyGroup: "This group uses an earlier format.",
  membersNeedUpdate: "Some group members need to update their app.",
  devicesNeedReplacement: "Some group members need a compatible device.",
  deviceLimitExceeded:
    "This group exceeds the number of devices supported per account.",
  eligible: "This group can support linked devices.",
};
