import { useLocales } from "expo-localization";

const english = {
  camera: "Turn camera on",
  cameraOff: "Turn camera off",
  switchCamera: "Switch camera",
  waiting: "Waiting for video approval…",
  local: "Your camera",
  remote: "Incoming video",
  consent: "Incoming video request",
  wants: (name: string) => `${name} wants to share video during this call.`,
  deny: "Deny",
  once: "Allow this time",
  always: "Always allow",
  toggle: "Show or hide call controls",
  swap: "Swap full-screen and floating video",
  automatic: "Automatically allow incoming video",
  active: "Video active",
  errors: {
    permission: "Allow camera access in Settings to share video.",
    capture: "The camera could not be opened.",
    background: "Camera sharing stopped when you left Boop.",
    denied: "The request was declined or expired.",
    timeout: "No response to the video request.",
    transmission: "Video could not be shared.",
    switch: "The other camera is unavailable.",
    preference: "Could not save this contact’s video preference.",
  },
};
const hebrew: typeof english = {
  camera: "הפעלת מצלמה",
  cameraOff: "כיבוי מצלמה",
  switchCamera: "החלפת מצלמה",
  waiting: "ממתינים לאישור שיתוף וידאו…",
  local: "המצלמה שלך",
  remote: "וידאו נכנס",
  consent: "בקשה לשיתוף וידאו",
  wants: (name) => `${name} רוצה לשתף וידאו במהלך השיחה.`,
  deny: "דחייה",
  once: "אישור לשיחה זו",
  always: "לאפשר תמיד",
  toggle: "הצגה או הסתרה של פקדי השיחה",
  swap: "החלפה בין הסרטון המלא לחלון הצף",
  automatic: "לאפשר אוטומטית וידאו נכנס",
  active: "וידאו פעיל",
  errors: {
    permission: "כדי לשתף וידאו יש לאפשר גישה למצלמה בהגדרות.",
    capture: "לא ניתן לפתוח את המצלמה.",
    background: "שיתוף המצלמה הופסק כשיצאת מ־Boop.",
    denied: "הבקשה נדחתה או שפג תוקפה.",
    timeout: "לא התקבלה תשובה לבקשת הווידאו.",
    transmission: "לא ניתן לשתף וידאו.",
    switch: "המצלמה השנייה אינה זמינה.",
    preference: "לא ניתן לשמור את העדפת הווידאו של איש הקשר.",
  },
};

export function useVideoLabels() {
  const language = useLocales()[0]?.languageCode;
  return language === "he" || language === "iw" ? hebrew : english;
}
