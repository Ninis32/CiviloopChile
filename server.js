const express   = require("express");
const mongoose  = require("mongoose");
const cors      = require("cors");
const bcrypt    = require("bcryptjs");
const jwt       = require("jsonwebtoken");
const path      = require("path");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// ── Servir archivos estaticos (HTML, CSS, JS) ──────────────
app.use(express.static(path.join(__dirname)));

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB conectado"))
  .catch(err => console.log("Error:", err));

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

app.post("/login", async (req, res) => {
  try {
    const { correo, password } = req.body;
    const usuario = await Usuario.findOne({ correo });
    if (!usuario)
      return res.status(401).json({ mensaje: "Correo o contrasena incorrectos" });
    if (!usuario.activo)
      return res.status(403).json({ mensaje: "Cuenta bloqueada" });
    const ok = await bcrypt.compare(password, usuario.password);
    console.log("PASSWORD OK:", ok);
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

app.get("/perfil", verificarJWT, async (req, res) => {
  try {
    const usuario = await Usuario.findById(req.user.id).select("-password");
    res.json(usuario);
  } catch {
    res.status(500).json({ mensaje: "Error al obtener perfil" });
  }
});

app.get("/api/puntos-limpios", verificarJWT, async (req, res) => {
  try {
    const puntos = await PuntoLimpio.find({ activo: true });
    res.json(puntos);
  } catch {
    res.status(500).json({ mensaje: "Error al obtener puntos limpios" });
  }
});

app.get("/api/beneficios", verificarJWT, async (req, res) => {
  try {
    const beneficios = await Beneficio.find({ activo: true, stock: { $gt: 0 } });
    res.json(beneficios);
  } catch {
    res.status(500).json({ mensaje: "Error al obtener beneficios" });
  }
});

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

app.post("/api/reciclaje/qr", verificarJWT, async (req, res) => {
  try {
    const { tipo_material, cantidad, id_punto, codigo_qr, observaciones } = req.body;
    const punto = await PuntoLimpio.findOne({ _id: id_punto, codigo_qr, activo: true });
    if (!punto) return res.status(404).json({ mensaje: "QR o punto limpio invalido" });
    const puntos_ganados = Math.max(5, Math.round((cantidad || 1) * 5));
    await new Historial({
      id_usuario: req.user.id,
      id_punto:   punto._id,
      nombre_punto: punto.nombre_punto,
      tipo_material, cantidad, puntos_ganados, observaciones
    }).save();
    await Usuario.findByIdAndUpdate(req.user.id, { $inc: { puntos_totales: puntos_ganados } });
    res.json({ mensaje: "Reciclaje registrado", puntos_ganados });
  } catch (err) {
    console.log(err);
    res.status(500).json({ mensaje: "Error al registrar reciclaje" });
  }
});

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

// Ruta raiz → sirve index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor en puerto", process.env.PORT || 3000);
  console.log("Abre: http://localhost:3000");
});
