const { defineConfig } = require("eslint/config");
const expo = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expo,
  {
    ignores: ["src/db/migrations/**", "dist/**", "modules/boop-marmot/sdk/**"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/icon.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react-native",
              importNames: [
                "Alert",
                "AlertButton",
                "AlertOptions",
                "Switch",
                "SwitchProps",
              ],
              message: "Use Boop's dialog or switch from src/components/ui.",
            },
            {
              name: "expo-symbols",
              message: "Use Boop's semantic Icon registry.",
            },
            ...[
              "@expo/ui/jetpack-compose",
              "@expo/ui/swift-ui",
              "@expo/ui",
            ].map((name) => ({
              name,
              importNames: ["AlertDialog", "BasicAlertDialog", "Switch"],
              message: "Use Boop's dialog or switch from src/components/ui.",
            })),
          ],
          patterns: [
            {
              group: [
                "react-native/**/Alert",
                "react-native/**/Switch",
                "@expo/ui/**/switch",
                "@expo/ui/**/alert-dialog",
              ],
              message: "Use Boop's dialog or switch from src/components/ui.",
            },
            {
              group: ["phosphor-react-native", "phosphor-react-native/**"],
              message: "Register the glyph in src/components/ui/icon.tsx.",
            },
          ],
        },
      ],
    },
  },
]);
