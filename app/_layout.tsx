import { Tabs } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConversationProvider } from "./context/ConversationContext";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ConversationProvider>
        <Tabs
          screenOptions={{
            headerShown: false,
            tabBarStyle: {
              backgroundColor: "#050b16",
              borderTopColor: "rgba(109, 214, 255, 0.2)",
            },
            tabBarActiveTintColor: "#6dd6ff",
            tabBarInactiveTintColor: "#7f96b6",
            tabBarLabelStyle: {
              fontSize: 12,
              fontWeight: "700",
              letterSpacing: 0.4,
              marginBottom: 6,
            },
          }}
        >
          <Tabs.Screen name="index" options={{ title: "Home" }} />
          <Tabs.Screen name="conversation" options={{ title: "Conversation" }} />
        </Tabs>
      </ConversationProvider>
    </SafeAreaProvider>
  );
}
