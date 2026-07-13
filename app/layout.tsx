import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Blind Ranking",
  description: "Blind Ranking als Telegram Mini App"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="de">
      <head>
        <script src="https://telegram.org/js/telegram-web-app.js" async />
      </head>
      <body>{children}</body>
    </html>
  );
}
