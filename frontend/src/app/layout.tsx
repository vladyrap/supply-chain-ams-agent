import type { Metadata } from "next";
import "../styles/globals.css";

export const metadata: Metadata = {
  title: "Agente AMS Supply Chain",
  description:
    "Diagnóstico inicial, clasificación y paso a paso para incidentes SAP Supply Chain.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
