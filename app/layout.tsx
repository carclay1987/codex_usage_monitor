import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Codex Usage Monitor',
  description: 'Локальный монитор расхода токенов в задачах Codex',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" className="dark">
      <body>{children}</body>
    </html>
  );
}
