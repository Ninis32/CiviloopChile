// generar_qr.js
// Genera imágenes QR para cada punto limpio en MongoDB
// node generar_qr.js

require("dotenv").config();
const mongoose = require("mongoose");
const QRCode   = require("qrcode");
const fs       = require("fs");
const path     = require("path");

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✓ MongoDB conectado"))
  .catch(err => { console.log(err); process.exit(1); });

const puntolimpio = mongoose.model("puntolimpio", new mongoose.Schema({
  nombre_punto: String,
  direccion:    String,
  codigo_qr:    String,
  activo:       Boolean
}));

async function generarQRs() {
  // Crear carpeta qr/ si no existe
  const carpeta = path.join(__dirname, "qr");
  if (!fs.existsSync(carpeta)) {
    fs.mkdirSync(carpeta);
    console.log("✓ Carpeta qr/ creada");
  }

  const puntos = await puntolimpio.find({ activo: true });

  if (!puntos.length) {
    console.log("No hay puntos limpios en la base de datos.");
    console.log("Corre primero: node insertar_puntos.js");
    mongoose.disconnect();
    return;
  }

  console.log(`\nGenerando QR para ${puntos.length} puntos limpios...\n`);

  for (const p of puntos) {
    const nombreArchivo = p.codigo_qr.replace(/[^a-zA-Z0-9]/g, "_") + ".png";
    const rutaArchivo   = path.join(carpeta, nombreArchivo);

    // El QR contiene el código del punto (lo que escanea el ciudadano)
    await QRCode.toFile(rutaArchivo, p.codigo_qr, {
      color: {
        dark:  "#1A5C35",  // verde oscuro
        light: "#FFFFFF"
      },
      width:  300,
      margin: 2
    });

    console.log(`✓ ${p.nombre_punto}`);
    console.log(`  Código: ${p.codigo_qr}`);
    console.log(`  Archivo: qr/${nombreArchivo}\n`);
  }

  console.log("✅ Todos los QR generados en la carpeta qr/");
  console.log("Imprime cada imagen y pégala en el punto limpio correspondiente.");
  mongoose.disconnect();
}

generarQRs().catch(console.error);
