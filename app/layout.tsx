import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "dummyplug",
  description: "Durable reference metadata and one continuous MiniMax H3 take.",
  icons: {
    icon: "/dummyplug-head.png",
    shortcut: "/dummyplug-head.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
