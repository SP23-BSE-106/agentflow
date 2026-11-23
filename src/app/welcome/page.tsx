import type { Metadata } from "next";

import WelcomePageClient from "@/components/welcome/WelcomePageClient";

export const metadata: Metadata = {
  title: "Welcome — AgentFlow",
  description: "Bring your own AI key and learn how to use AgentFlow.",
};

export default function WelcomePage() {
  return <WelcomePageClient />;
}
