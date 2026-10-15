/* HTTP intranet compatibility for client request IDs; never used for credentials. */
(function () {
  "use strict";
  var webCrypto = globalThis.crypto;
  if (!webCrypto || typeof webCrypto.randomUUID === "function") return;
  if (typeof webCrypto.getRandomValues !== "function") return;
  Object.defineProperty(webCrypto, "randomUUID", {
    configurable: true,
    value: function () {
      var bytes = new Uint8Array(16);
      webCrypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      var hex = Array.from(bytes, function (byte) {
        return byte.toString(16).padStart(2, "0");
      });
      return [hex.slice(0, 4).join(""), hex.slice(4, 6).join(""),
        hex.slice(6, 8).join(""), hex.slice(8, 10).join(""),
        hex.slice(10, 16).join("")].join("-");
    }
  });
})();
