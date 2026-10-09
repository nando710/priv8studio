import type { Metadata } from "next";
import "./studio.css";

export const metadata: Metadata = {
  title: "PRIV8 Studio — crie com sua identidade",
  description: "Seu estúdio de criação, conectado ao RunningHub.",
  icons: {
    icon: "/favicon.png",
    shortcut: "/favicon.png",
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body className="antialiased">{children}</body>
    </html>
  );
}
