import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Kangguircm RCM Command Center", description: "Lead generation and AI outreach for US healthcare practices" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
