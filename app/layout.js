import './globals.css';

export const metadata = {
  title: 'Maps Site Checker',
  description: 'Import a CSV, map columns, scan each website with a local Ollama model.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
