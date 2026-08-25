import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "dummyplug",
  description: "Durable reference metadata and one continuous MiniMax H3 take.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
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
