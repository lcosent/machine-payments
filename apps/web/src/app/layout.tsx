import type { ReactNode } from 'react';

export const metadata = {
  title: 'AutoCompute',
  description: 'Agent-to-agent compute marketplace PoC',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          margin: 0,
          padding: 0,
          background: '#0b0b10',
          color: '#e4e4e7',
        }}
      >
        {children}
      </body>
    </html>
  );
}
