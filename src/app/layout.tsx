import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Workforce Intelligence",
  description: "A governed view of your workforce, capacity, and plans.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
