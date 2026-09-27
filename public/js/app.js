// Forms with data-confirm ask before submitting (inline handlers are blocked by the CSP).
document.addEventListener('submit', (event) => {
  const message = event.target.getAttribute('data-confirm');
  if (message && !window.confirm(message)) event.preventDefault();
});
// Selects with data-autosubmit submit their form on change (filters).
document.addEventListener('change', (event) => {
  if (event.target.matches('[data-autosubmit]')) event.target.form.submit();
});
// Buttons with data-confirm-button ask before submitting their form.
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-confirm-button]');
  if (button && !window.confirm(button.getAttribute('data-confirm-button'))) event.preventDefault();
});
// Live BMI from height and weight on the consultation form.
document.addEventListener('input', (event) => {
  if (!event.target.matches('[data-bmi]')) return;
  const form = event.target.form;
  const h = Number(form.elements.height_cm.value) / 100;
  const w = Number(form.elements.weight_kg.value);
  const out = form.querySelector('[data-bmi-output]');
  if (out) out.textContent = h && w ? (Math.round((w / (h * h)) * 10) / 10).toString() : '–';
});
