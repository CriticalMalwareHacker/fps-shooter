import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PulseStrike Arena",
  description: "Multiplayer browser FPS you can deploy on Vercel and play with friends.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
