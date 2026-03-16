import DOMPurify from "../vendor/purify.es.mjs";
import { marked } from "../vendor/marked.esm.js";

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function buildMarkdownNode(text) {
  const wrapper = document.createElement("div");
  wrapper.className = "message-markdown";

  const rendered = marked.parse(text);
  wrapper.innerHTML = DOMPurify.sanitize(typeof rendered === "string" ? rendered : "");

  for (const link of wrapper.querySelectorAll("a")) {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noreferrer noopener");
  }

  return wrapper;
}
