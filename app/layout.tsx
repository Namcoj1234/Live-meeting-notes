import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Live Meeting Notes",
  description: "Personal recording, transcription, translation, and meeting memory."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
