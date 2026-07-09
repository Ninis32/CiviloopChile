// preparar_deploy.js
// Reemplaza http://localhost:3000 por tu URL de Render en todos los archivos
// node preparar_deploy.js

const fs   = require("fs");
const path = require("path");

const NUEVA_URL = "https://civiloopchile.onrender.com";
const LOCAL     = "http://localhost:3000";
const EXTS      = [".html", ".js"];
const IGNORAR   = ["node_modules", ".git", "preparar_deploy.js",
                   "insertar_puntos.js", "arreglar_password.js", "generar_qr.js"];

let cambiados = 0;

function procesarArchivo(ruta) {
  let contenido = fs.readFileSync(ruta, "utf8");
  if (contenido.includes(LOCAL)) {
    fs.writeFileSync(ruta, contenido.replaceAll(LOCAL, NUEVA_URL), "utf8");
    console.log("✓ " + path.basename(ruta));
    cambiados++;
  }
}

function recorrer(dir) {
  fs.readdirSync(dir).forEach(item => {
    if (IGNORAR.some(i => item.includes(i))) return;
    const ruta = path.join(dir, item);
    if (fs.statSync(ruta).isDirectory()) recorrer(ruta);
    else if (EXTS.includes(path.extname(item))) procesarArchivo(ruta);
  });
}

console.log("Reemplazando " + LOCAL + " → " + NUEVA_URL + "\n");
recorrer(".");
console.log("\n✅ " + cambiados + " archivos actualizados.");
console.log("Ahora corre: git add . && git commit -m 'fix: URL produccion' && git push");
