/* Injected (after detect.js) into every frame of the active tab when the popup opens.
   Returns the page URL, likely "main video" URLs and any list of individual video links. */
(() => globalThis.__jdDetect.detect(document, location.href, window === window.top))();
