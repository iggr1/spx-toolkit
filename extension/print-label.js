const params = new URLSearchParams(location.search);
const src = params.get('src') || '';
const name = params.get('name') || 'Etiqueta';
const width = Number(params.get('width')) || 70;
const height = Number(params.get('height')) || 40;
const scale = (Number(params.get('scale')) || 100) / 100;
const padding = Number(params.get('padding')) || 0;
const rotate = Number(params.get('rotate')) || 0;
const fit = ['contain', 'cover', 'fill'].includes(params.get('fit')) ? params.get('fit') : 'contain';

const image = document.getElementById('labelImage');
const title = document.getElementById('labelTitle');
const printInfo = document.getElementById('printInfo');
const printBtn = document.getElementById('printBtn');
const openImageBtn = document.getElementById('openImageBtn');

function applyPrintSettings() {
  document.documentElement.style.setProperty('--label-width', width + 'mm');
  document.documentElement.style.setProperty('--label-height', height + 'mm');
  document.documentElement.style.setProperty('--label-padding', Math.max(0, padding) + 'mm');
  document.documentElement.style.setProperty('--label-scale', String(Math.max(0.1, scale)));
  document.documentElement.style.setProperty('--label-rotate', rotate + 'deg');
  document.documentElement.style.setProperty('--label-fit', fit === 'fill' ? 'fill' : fit);
}

function printImage() {
  window.focus();
  window.print();
}

applyPrintSettings();

if (title) title.textContent = name;
if (printInfo) {
  printInfo.textContent = `Página configurada para ${width}x${height}mm, escala interna ${Math.round(scale * 100)}%, margem interna ${padding}mm, rotação ${rotate}°. No modal: papel ${width}x${height}mm, margens nenhuma, escala 100%.`;
}
document.title = 'Imprimir - ' + name;

if (src && image) {
  image.src = src;
} else {
  document.body.innerHTML = '<p style="padding:20px;font-family:Arial">Imagem não informada.</p>';
}

if (printBtn) printBtn.addEventListener('click', printImage);
if (openImageBtn) openImageBtn.addEventListener('click', () => {
  if (src) window.open(src, '_blank');
});

if (image) {
  image.addEventListener('load', () => {
    setTimeout(printImage, 450);
  });
}
