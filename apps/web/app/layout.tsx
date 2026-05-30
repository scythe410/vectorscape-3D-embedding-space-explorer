import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VectorScape",
  description: "Fly through your embeddings.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
