const sections = document.querySelectorAll(".scroll-section");

const animateCounter = (counter) => {
  const target = Number(counter.dataset.target);
  const step = Math.ceil(target / 100);
  const update = () => {
    const current = Number(counter.textContent);
    if (current < target) {
      counter.textContent = String(Math.min(current + step, target));
      requestAnimationFrame(update);
    }
  };
  update();
};

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("fade-in");
          entry.target
            .querySelectorAll(".counter")
            .forEach((counter) => animateCounter(counter));
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1 }
  );

  sections.forEach((section) => observer.observe(section));
} else {
  sections.forEach((section) => section.classList.add("fade-in"));
}
