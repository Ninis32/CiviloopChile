const express  = require("express");
const mongoose = require("mongoose");
const cors     = require("cors");
const bcrypt   = require("bcryptjs");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());


// ── Conexión MongoDB Atlas ────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✓ MongoDB conectado"))
  .catch(err => console.log("✗ Error MongoDB:", err));

  mongoose.connection.once("open", ()=> {
    console.log("BASE DE DATOS:", mongoose.connection.name);
  });

// ── Modelo Usuario ────────────────────────────────────────
const usuarioSchema = new mongoose.Schema({
  nombre:   { type: String, required: true },
  correo:   { type: String, required: true, unique: true },
  password: { type: String, required: true },  // guardará el HASH
  region:   { type: String, required: true },
  rol:              { type: String, default: "ciudadano" },
  puntos_totales:   { type: Number, default: 0 },
  fecha_registro:   { type: Date,   default: Date.now },
  activo:           { type: Boolean, default: true }
});

const Usuario = mongoose.model("Usuario", usuarioSchema);

// ── GET / ─────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("CiviLoop Chile API funcionando");
});
app.get("/test", async (req, res) => {
  const usuarios = await Usuario.find();
  console.log(usuarios);
  res.json(usuarios);
});

// ── POST /registro ────────────────────────────────────────
app.post("/registro", async (req, res) => {
  try {
    const { nombre, correo, password, region } = req.body;

    // 1. Validar que no falten campos
    if (!nombre || !correo || !password || !region) {
      return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
    }

    // 2. Verificar si el correo ya existe
    const existe = await Usuario.findOne({ correo });
    if (existe) {
      return res.status(400).json({ mensaje: "El correo ya está registrado" });
    }

    // 3. Cifrar la contraseña con bcrypt (12 = factor de costo)
    const hash = await bcrypt.hash(password, 12);

    // 4. Guardar usuario con el hash, NO con la contraseña en texto plano
    const nuevoUsuario = new Usuario({
      nombre,
      correo,
      password: hash,   
      region
    });

    await nuevoUsuario.save();

    const total = await Usuario.countDocuments();
    console.log("✓ Usuario registrado. Total:", total);

    res.json({ mensaje: "Usuario registrado correctamente" });

  } catch (error) {
    console.log("✗ Error registro:", error);
    res.status(500).json({ mensaje: "Error al guardar usuario" });
  }
});

// ── POST /login ───────────────────────────────────────────
app.post("/login", async (req, res) => {
  try {
    const { correo, password } = req.body;

    // 1. Buscar usuario por correo
    const usuario = await Usuario.findOne({ correo });

console.log("CORREO BUSCADO:", correo);
console.log("USUARIO ENCONTRADO:", usuario);

if (!usuario) {
  return res.status(401).json({
    mensaje: "Correo o contraseña incorrectos"
  });
}

    // 2. Comparar contraseña ingresada con el hash guardado
    const coincide = await bcrypt.compare(password, usuario.password);
    if ( !coincide) {
      return res.status(401).json({
        mensaje: "correo o contraseña incorrecta"
      })
    };
    
  

    // 3. Login exitoso
    res.json({
      mensaje: "Login exitoso",
      usuario: {
        nombre:        usuario.nombre,
        correo:        usuario.correo,
        region:        usuario.region,
        puntos_totales:usuario.puntos_totales
      }
    });

  } catch (error) {
    console.log("✗ Error login:", error);
    res.status(500).json({ mensaje: "Error al iniciar sesión" });
  }
});

// ── Iniciar servidor ──────────────────────────────────────
app.listen(process.env.PORT || 3000, () => {
  console.log("✓ Servidor iniciado en puerto", process.env.PORT || 3000);
});
