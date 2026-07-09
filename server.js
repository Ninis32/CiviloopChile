const express  = require("express");
const mongoose = require("mongoose");
const cors     = require("cors");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const path     = require("path");
const axios    = require("axios");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB conectado"))
  .catch(err => console.log("Error:", err));

// ── Modelos ────────────────────────────────────────────────
const Usuario = mongoose.model("Usuario", new mongoose.Schema({
  nombre:         { type: String, required: true },
  correo:         { type: String, required: true, unique: true },
  password:       { type: String, required: true },
  region:         { type: String, required: true },
  rol:            { type: String, default: "ciudadano" },
  puntos_totales: { type: Number, default: 0 },
  fecha_registro: { type: Date,   default: Date.now },
  activo:         { type: Boolean, default: true }
}));

const PuntoLimpio = mongoose.model("PuntoLimpio", new mongoose.Schema({
  nombre_punto: { type: String, required: true },
  direccion:    { type: String, required: true },
  lat:          Number,
  lng:          Number,
  codigo_qr:    { type: String, unique: true },
  materiales:   [String],
  activo:       { type: Boolean, default: true }
}));

const Beneficio = mongoose.model("Beneficio", new mongoose.Schema({
  titulo:            String,
  descripcion:       String,
  puntos_requeridos: { type: Number, required: true },
  stock:             { type: Number, default: 0 },
  activo:            { type: Boolean, default: true }
}));

const Historial = mongoose.model("Historial", new mongoose.Schema({
  id_usuario:     { type: mongoose.Schema.Types.ObjectId, ref: "Usuario" },
  id_punto:       { type: mongoose.Schema.Types.ObjectId, ref: "PuntoLimpio" },
  nombre_punto:   String,
  tipo_material:  String,
  cantidad:       Number,
  puntos_ganados: Number,
  observaciones:  String,
  fecha_actividad:{ type: Date, default: Date.now }
}));

const Canje = mongoose.model("Canje", new mongoose.Schema({
  id_usuario:        { type: mongoose.Schema.Types.ObjectId, ref: "Usuario" },
  id_beneficio:      { type: mongoose.Schema.Types.ObjectId, ref: "Beneficio" },
  puntos_utilizados: Number,
  fecha_canje:       { type: Date, default: Date.now },
  estado_canje:      { type: String, default: "pendiente" }
}));

// ── Middleware JWT ──────────────────────────
function verificarJWT(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ mensaje: "Token requerido" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ mensaje: "Token invalido o expirado" });
  }
}

app.post("/registro", async (req, res) => {
  try {
    const { nombre, correo, password, region } = req.body;
    if (!nombre || !correo || !password || !region)
      return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
    if (await Usuario.findOne({ correo }))
      return res.status(400).json({ mensaje: "El correo ya esta registrado" });
    const hash = await bcrypt.hash(password, 12);
    await new Usuario({ nombre, correo, password: hash, region }).save();
    res.json({ mensaje: "Usuario registrado correctamente" });
  } catch (err) {
    console.log(err);
    res.status(500).json({ mensaje: "Error al registrar usuario" });
  }
});

// ── POST /login ────────────────────────────────────────────
app.post("/login", async (req, res) => {
  try {
    const { correo, password } = req.body;
    const usuario = await Usuario.findOne({ correo });
    if (!usuario)
      return res.status(401).json({ mensaje: "Correo o contrasena incorrectos" });
    if (!usuario.activo)
      return res.status(403).json({ mensaje: "Cuenta bloqueada" });
    const ok = await bcrypt.compare(password, usuario.password);
    if (!ok)
      return res.status(401).json({ mensaje: "Correo o contrasena incorrectos" });
    const token = jwt.sign(
      { id: usuario._id, correo: usuario.correo, rol: usuario.rol },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );
    res.json({
      mensaje: "Login exitoso",
      token,
      usuario: {
        nombre:         usuario.nombre,
        correo:         usuario.correo,
        region:         usuario.region,
        rol:            usuario.rol,
        puntos_totales: usuario.puntos_totales
      }
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({ mensaje: "Error al iniciar sesion" });
  }
});

// ── POST /recuperar-password ───────────────────────────────
app.post("/recuperar-password", async (req, res) => {
  const { correo } = req.body;
  try {
    const usuario = await Usuario.findOne({ correo });
    if (!usuario)
      return res.json({ mensaje: "Si el correo existe, recibiras un enlace." });

    const token  = jwt.sign({ id: usuario._id }, process.env.JWT_SECRET, { expiresIn: "15m" });
    const enlace = `https://civiloopchile.onrender.com/restablecer.html?token=${token}`;

    await axios.post("https://api.brevo.com/v3/smtp/email",
      {
        sender:      { name: "Civiloop Chile", email: process.env.EMAIL_FROM },
        to:          [{ email: correo }],
        subject:     "Recuperar contrasena - Civiloop Chile",
        htmlContent: `
          <h2>Civiloop Chile</h2>
          <p>Haz clic en el siguiente enlace para restablecer tu contrasena:</p>
          <a href="${enlace}" style="background:#2E8B57;color:white;padding:10px 20px;
            border-radius:8px;text-decoration:none;display:inline-block">
            Restablecer contrasena
          </a>
          <p style="color:#888;font-size:0.85rem;margin-top:12px">
            Este enlace vence en 15 minutos.
          </p>
        `
      },
      { headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json" } }
    );

    res.json({ mensaje: "Si el correo existe, recibiras un enlace." });

  } catch (error) {
    console.log("ERROR BREVO:", error.response?.data || error.message);
    res.status(500).json({ mensaje: "Error enviando correo." });
  }
});

// ── POST /restablecer-password ─────────────────────────────
app.post("/restablecer-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password)
    return res.status(400).json({ mensaje: "Datos incompletos" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const hash    = await bcrypt.hash(password, 12);
    await Usuario.findByIdAndUpdate(payload.id, { password: hash });
    res.json({ mensaje: "Contrasena actualizada correctamente." });
  } catch {
    res.status(400).json({ mensaje: "El enlace es invalido o ya expiro." });
  }
});

// ── GET /perfil ────────────────────────────────────────────
app.get("/perfil", verificarJWT, async (req, res) => {
  try {
    const usuario = await Usuario.findById(req.user.id).select("-password");
    res.json(usuario);
  } catch {
    res.status(500).json({ mensaje: "Error al obtener perfil" });
  }
});

// ── GET /api/puntos-limpios ────────────────────────────────
app.get("/api/puntos-limpios", verificarJWT, async (req, res) => {
  try {
    const puntos = await PuntoLimpio.find({ activo: true });
    res.json(puntos);
  } catch {
    res.status(500).json({ mensaje: "Error al obtener puntos limpios" });
  }
});

// ── GET /api/beneficios ────────────────────────────────────
app.get("/api/beneficios", verificarJWT, async (req, res) => {
  try {
    const beneficios = await Beneficio.find({ activo: true, stock: { $gt: 0 } });
    res.json(beneficios);
  } catch {
    res.status(500).json({ mensaje: "Error al obtener beneficios" });
  }
});

// ── GET /api/historial ─────────────────────────────────────
app.get("/api/historial", verificarJWT, async (req, res) => {
  try {
    const historial = await Historial
      .find({ id_usuario: req.user.id })
      .sort({ fecha_actividad: -1 })
      .limit(20);
    res.json(historial);
  } catch {
    res.status(500).json({ mensaje: "Error al obtener historial" });
  }
});

// ── POST /api/reciclaje/qr ─────────────────────────────────
app.post("/api/reciclaje/qr", verificarJWT, async (req, res) => {
  try {
    const { tipo_material, cantidad, id_punto, codigo_qr, observaciones } = req.body;
    const punto = await PuntoLimpio.findOne({ _id: id_punto, codigo_qr, activo: true });
    if (!punto) return res.status(404).json({ mensaje: "QR o punto limpio invalido" });
    const puntos_ganados = Math.max(5, Math.round((cantidad || 1) * 5));
    await new Historial({
      id_usuario:   req.user.id,
      id_punto:     punto._id,
      nombre_punto: punto.nombre_punto,
      tipo_material, cantidad, puntos_ganados, observaciones
    }).save();
    await Usuario.findByIdAndUpdate(req.user.id, { $inc: { puntos_totales: puntos_ganados } });
    res.json({ mensaje: "Reciclaje registrado", puntos_ganados });
  } catch (err) {
    console.log(err);
    res.status(500).json({ mensaje: "Error al registrar_reciclaje" });
  }
});

// ── POST /api/canjes ───────────────────────────────────────
app.post("/api/canjes", verificarJWT, async (req, res) => {
  try {
    const { id_beneficio } = req.body;
    const beneficio = await Beneficio.findOne({ _id: id_beneficio, activo: true, stock: { $gt: 0 } });
    if (!beneficio) return res.status(400).json({ mensaje: "Beneficio no disponible" });
    const usuario = await Usuario.findById(req.user.id);
    if (usuario.puntos_totales < beneficio.puntos_requeridos)
      return res.status(400).json({ mensaje: "Puntos insuficientes" });
    await Usuario.findByIdAndUpdate(req.user.id, { $inc: { puntos_totales: -beneficio.puntos_requeridos } });
    await Beneficio.findByIdAndUpdate(id_beneficio, { $inc: { stock: -1 } });
    await new Canje({ id_usuario: req.user.id, id_beneficio, puntos_utilizados: beneficio.puntos_requeridos }).save();
    res.json({ mensaje: "Canje realizado con exito" });
  } catch (err) {
    console.log(err);
    res.status(500).json({ mensaje: "Error al realizar canje" });
  }
});

// ── GET / ──────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor en puerto", process.env.PORT || 3000);
  console.log("Abre: https://civiloopchile.onrender.com");
});

// GET /api/admin/usuarios — listar todos los usuarios
app.get("/api/admin/usuarios", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol === "ciudadano")
      return res.status(403).json({ mensaje: "Sin permisos" });
    const usuarios = await Usuario.find().select("-password").sort({ fecha_registro: -1 });
    res.json(usuarios);
  } catch {
    res.status(500).json({ mensaje: "Error al obtener usuarios" });
  }
});

// PUT /api/admin/usuarios/:id/estado — activar o bloquear usuario
app.put("/api/admin/usuarios/:id/estado", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol === "ciudadano")
      return res.status(403).json({ mensaje: "Sin permisos" });
    const { activo } = req.body;
    await Usuario.findByIdAndUpdate(req.params.id, { activo });
    res.json({ mensaje: activo ? "Usuario activado" : "Usuario bloqueado" });
  } catch {
    res.status(500).json({ mensaje: "Error al actualizar usuario" });
  }
});

// POST /api/admin/puntos-limpios — crear punto limpio
app.post("/api/admin/puntos-limpios", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol === "ciudadano")
      return res.status(403).json({ mensaje: "Sin permisos" });
    const { nombre_punto, direccion, lat, lng, codigo_qr, materiales } = req.body;
    const nuevo = new PuntoLimpio({ nombre_punto, direccion, lat, lng, codigo_qr, materiales });
    await nuevo.save();
    res.json({ mensaje: "Punto limpio creado", punto: nuevo });
  } catch (err) {
    res.status(500).json({ mensaje: "Error al crear punto limpio" });
  }
});

// POST /api/admin/beneficios — crear beneficio
app.post("/api/admin/beneficios", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol === "ciudadano")
      return res.status(403).json({ mensaje: "Sin permisos" });
    const { titulo, descripcion, puntos_requeridos, stock } = req.body;
    const nuevo = new Beneficio({ titulo, descripcion, puntos_requeridos, stock, activo: true });
    await nuevo.save();
    res.json({ mensaje: "Beneficio creado", beneficio: nuevo });
  } catch {
    res.status(500).json({ mensaje: "Error al crear beneficio" });
  }
});
