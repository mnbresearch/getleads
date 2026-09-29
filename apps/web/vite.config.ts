import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { FAQS } from "./src/content/faq";

/**
 * Write the FAQ structured data into index.html at build time.
 *
 * This app is client-rendered, so anything React emits only exists after JavaScript has
 * run. Search crawlers mostly cope with that; the AI crawlers this product exists to be
 * seen by are far less consistent about it. Static markup in the shipped HTML is the only
 * version every reader is guaranteed to get.
 *
 * Generating it from the same array the page renders means the answers a machine reads and
 * the answers a person reads cannot drift apart - which is the failure mode of every
 * hand-maintained copy of the same content.
 */
function faqSchema() {
  return {
    name: "faq-schema",
    transformIndexHtml(html: string) {
      const json = JSON.stringify({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: FAQS.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      });
      // `</script>` inside a JSON string would close this tag early and break the page.
      const safe = json.replace(/</g, "\\u003c");
      return html.replace("</head>", `    <script type="application/ld+json">${safe}</script>\n  </head>`);
    },
  };
}

export default defineConfig({
  plugins: [react(), faqSchema()],
  server: { port: 5173 },
  build: { outDir: "dist", sourcemap: false },
});
