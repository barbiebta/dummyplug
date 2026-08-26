import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "dummyplug",
  description: "Project asset libraries and self-contained MiniMax H3 job bundles.",
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
