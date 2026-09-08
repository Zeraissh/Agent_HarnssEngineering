(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll(".slide[data-slide]"));
  if (!slides.length) return;
  var i = Math.max(0, slides.findIndex(function (s) { return s.classList.contains("is-active"); }));
  if (i < 0) i = 0;

  function show(n) {
    i = (n + slides.length) % slides.length;
    slides.forEach(function (s, idx) {
      s.classList.toggle("is-active", idx === i);
    });
  }

  document.addEventListener("keydown", function (ev) {
    if (ev.key === "ArrowRight" || ev.key === "PageDown" || ev.key === " ") {
      ev.preventDefault();
      show(i + 1);
    } else if (ev.key === "ArrowLeft" || ev.key === "PageUp") {
      ev.preventDefault();
      show(i - 1);
    }
  });

  show(i);
})();
