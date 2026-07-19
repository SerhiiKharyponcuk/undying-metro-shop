// Добавьте готовые ссылки сюда. Пока значения пустые — кнопки работают как заглушки.
const LINKS = {
  shop: "",
  managers: "",
  donate: "",
  telegram: "",
};

const toast = document.querySelector("#toast");
let toastTimer;

function showPlaceholderMessage() {
  window.clearTimeout(toastTimer);
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => {
    toast.classList.remove("is-visible");
  }, 2600);
}

document.querySelectorAll("[data-link]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const url = LINKS[link.dataset.link];

    if (!url) {
      showPlaceholderMessage();
      return;
    }

    window.open(url, "_blank", "noopener,noreferrer");
  });
});

const particles = document.querySelector("#particles");
const particleColors = ["#55f4e1", "#19cbbd", "#ffb348"];

for (let index = 0; index < 22; index += 1) {
  const particle = document.createElement("span");
  particle.className = "particle";
  particle.style.setProperty("--x", `${Math.random() * 100}%`);
  particle.style.setProperty("--size", `${1 + Math.random() * 2.6}px`);
  particle.style.setProperty("--duration", `${10 + Math.random() * 12}s`);
  particle.style.setProperty("--delay", `${Math.random() * -20}s`);
  particle.style.setProperty("--drift", `${-55 + Math.random() * 110}px`);
  particle.style.setProperty(
    "--color",
    particleColors[Math.floor(Math.random() * particleColors.length)],
  );
  particles.appendChild(particle);
}

if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  window.addEventListener(
    "pointermove",
    (event) => {
      document.documentElement.style.setProperty("--pointer-x", `${event.clientX}px`);
      document.documentElement.style.setProperty("--pointer-y", `${event.clientY}px`);
    },
    { passive: true },
  );
}
