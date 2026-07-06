// insertar_puntos.js
// Corre UNA SOLA VEZ para cargar puntos limpios de ejemplo
// node insertar_puntos.js

require("dotenv").config();
const mongoose = require("mongoose");

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✓ MongoDB conectado"))
  .catch(err => { console.log(err); process.exit(1); });

const PuntoLimpio = mongoose.model("PuntoLimpio", new mongoose.Schema({
  nombre_punto: String,
  direccion:    String,
  lat:          Number,
  lng:          Number,
  codigo_qr:    { type: String, unique: true },
  materiales:   [String],
  activo:       { type: Boolean, default: true }
}));

const puntos = [
  {
    nombre_punto: "Punto Limpio Plaza Italia",
    direccion:    "Av. Libertador B. O'Higgins 3450, Santiago",
    lat:          -33.4489,
    lng:          -70.6467,
    codigo_qr:    "QR-00001",
    materiales:   ["Plástico", "Vidrio", "Papel"]
  },
  {
    nombre_punto: "Punto Limpio Providencia",
    direccion:    "Av. Providencia 1234, Providencia",
    lat:          -33.4317,
    lng:          -70.6147,
    codigo_qr:    "QR-00002",
    materiales:   ["Plástico", "Metal", "Cartón"]
  },
  {
    nombre_punto: "Punto Limpio Las Condes",
    direccion:    "Av. Apoquindo 5000, Las Condes",
    lat:          -33.4094,
    lng:          -70.5738,
    codigo_qr:    "QR-00003",
    materiales:   ["Vidrio", "Papel", "Electrónicos"]
  },
  {
    nombre_punto: "Punto Limpio Ñuñoa",
    direccion:    "Av. Irarrázaval 3200, Ñuñoa",
    lat:          -33.4561,
    lng:          -70.6008,
    codigo_qr:    "QR-00004",
    materiales:   ["Plástico", "Vidrio", "Metal", "Papel"]
  },
  {
    nombre_punto: "Punto Limpio Maipú",
    direccion:    "Av. Pajaritos 2200, Maipú",
    lat:          -33.5115,
    lng:          -70.7654,
    codigo_qr:    "QR-00005",
    materiales:   ["Plástico", "Cartón"]
  },
  {
    nombre_punto: "Punto Limpio Santiago Centro",
    direccion:    "Av. Alameda 1600, Santiago",
    lat:          -33.4433,
    lng:          -70.6653,
    codigo_qr:    "QR-00006",
    materiales:   ["Papel", "Cartón", "Vidrio"]
  },
  {
    nombre_punto: "Punto Limpio La Florida",
    direccion:    "Av. Vicuña Mackenna 7110, La Florida",
    lat:          -33.5169,
    lng:          -70.5985,
    codigo_qr:    "QR-00007",
    materiales:   ["Plástico", "Metal", "Vidrio"]
  }
];

async function insertar() {
  let insertados = 0;
  let omitidos   = 0;

  for (const p of puntos) {
    const existe = await PuntoLimpio.findOne({ codigo_qr: p.codigo_qr });
    if (existe) {
      console.log(`— Ya existe: ${p.nombre_punto}`);
      omitidos++;
    } else {
      await new PuntoLimpio(p).save();
      console.log(`✓ Insertado: ${p.nombre_punto} (${p.codigo_qr})`);
      insertados++;
    }
  }

  console.log(`\n✅ Listo: ${insertados} insertados, ${omitidos} ya existían`);
  console.log("Ahora el mapa y el formulario de reciclaje mostrarán los puntos.");
  mongoose.disconnect();
}

insertar().catch(console.error);
