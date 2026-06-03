import type { Metadata } from "next";
import { Fraunces, DM_Sans, JetBrains_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

// Design system per design.md — characterful display, quiet body, precise mono.
const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  axes: ["opsz", "SOFT", "WONK"],
  display: "swap",
});
const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "VectorScape — fly through your embeddings",
  description:
    "An observatory of meaning. Upload a CSV, watch it cluster as a galaxy, and explore the gaps between ideas.",
  icons: [
    {
      url: "/black-hole-16px.png",
      sizes: "16x16",
      type: "image/png",
    },
    {
      url: "/black-hole-32px.png",
      sizes: "32x32",
      type: "image/png",
    },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${dmSans.variable} ${jetbrains.variable}`}
    >
      {/*
        suppressHydrationWarning: browser extensions (ColorZilla, Grammarly,
        LastPass, etc.) routinely inject attributes onto <body> *before* React
        hydrates — `cz-shortcut-listen`, `data-new-gr-c-s-check-loaded`, etc.
        React then logs a hydration warning that has nothing to do with our
        code. Suppressing it on body only is the React-recommended workaround.
      */}
      <body className="font-body" suppressHydrationWarning>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
