const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Conexión MongoDB ──
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB conectado"))
  .catch(err => console.log("❌ Error MongoDB:", err));

// ── Modelos ──
const Usuario = mongoose.model("Usuario", new mongoose.Schema({
  nombre: { type: String, required: true },
  correo: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  region: { type: String, required: true },
  rol: { type: String, default: "ciudadano" },
  puntos_totales: { type: Number, default: 0 },
  fecha_registro: { type: Date, default: Date.now },
  activo: { type: Boolean, default: true }
}));

const PuntoLimpio = mongoose.model("PuntoLimpio", new mongoose.Schema({
  nombre_punto: { type: String, required: true },
  direccion: { type: String, required: true },
  lat: Number,
  lng: Number,
  codigo_qr: { type: String, unique: true },
  materiales: [String],
  activo: { type: Boolean, default: true }
}));

const Beneficio = mongoose.model("Beneficio", new mongoose.Schema({
  titulo: String,
  descripcion: String,
  puntos_requeridos: { type: Number, required: true },
  stock: { type: Number, default: 0 },
  activo: { type: Boolean, default: true }
}));

const Historial = mongoose.model("Historial", new mongoose.Schema({
  id_usuario: { type: mongoose.Schema.Types.ObjectId, ref: "Usuario" },
  id_punto: { type: mongoose.Schema.Types.ObjectId, ref: "PuntoLimpio" },
  nombre_punto: String,
  tipo_material: String,
  cantidad: Number,
  puntos_ganados: Number,
  observaciones: String,
  fecha_actividad: { type: Date, default: Date.now }
}));

const Canje = mongoose.model("Canje", new mongoose.Schema({
  id_usuario: { type: mongoose.Schema.Types.ObjectId, ref: "Usuario" },
  id_beneficio: { type: mongoose.Schema.Types.ObjectId, ref: "Beneficio" },
  puntos_utilizados: Number,
  fecha_canje: { type: Date, default: Date.now },
  estado_canje: { type: String, default: "pendiente" }
}));

// ── Middleware JWT ──
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

// ══════════════════════════════════════════
// RUTAS PÚBLICAS
// ══════════════════════════════════════════
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
    res.status(500).json({ mensaje: "Error al registrar usuario" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { correo, password } = req.body;
    const usuario = await Usuario.findOne({ correo });
    if (!usuario) return res.status(401).json({ mensaje: "Correo o contrasena incorrectos" });
    if (!usuario.activo) return res.status(403).json({ mensaje: "Cuenta bloqueada" });
    const ok = await bcrypt.compare(password, usuario.password);
    if (!ok) return res.status(401).json({ mensaje: "Correo o contrasena incorrectos" });
    const token = jwt.sign(
      { id: usuario._id, correo: usuario.correo, rol: usuario.rol },
      process.env.JWT_SECRET, { expiresIn: "8h" }
    );
    res.json({
      mensaje: "Login exitoso", token,
      usuario: {
        nombre: usuario.nombre, correo: usuario.correo,
        region: usuario.region, rol: usuario.rol,
        puntos_totales: usuario.puntos_totales
      }
    });
  } catch (err) {
    res.status(500).json({ mensaje: "Error al iniciar sesion" });
  }
});

app.post("/recuperar-password", async (req, res) => {
  const { correo } = req.body;
  try {
    const usuario = await Usuario.findOne({ correo });
    if (!usuario) return res.json({ mensaje: "Si el correo existe, recibiras un enlace." });
    const token = jwt.sign({ id: usuario._id }, process.env.JWT_SECRET, { expiresIn: "15m" });
    const enlace = "https://civiloopchile.onrender.com/restablecer.html?token=" + token;
    await axios.post("https://api.brevo.com/v3/smtp/email", {
      sender: { name: "Civiloop Chile", email: process.env.EMAIL_FROM },
      to: [{ email: correo }],
      subject: "Recuperar contrasena - Civiloop Chile",
      htmlContent: "<h2>Civiloop Chile</h2><p>Haz clic para restablecer:</p><a href='" + enlace + "' style='background:#2E8B57;color:white;padding:10px 20px;border-radius:8px;text-decoration:none'>Restablecer</a>"
    }, { headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json" } });
    res.json({ mensaje: "Si el correo existe, recibiras un enlace." });
  } catch (error) {
    res.status(500).json({ mensaje: "Error enviando correo." });
  }
});

app.post("/restablecer-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ mensaje: "Datos incompletos" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const hash = await bcrypt.hash(password, 12);
    await Usuario.findByIdAndUpdate(payload.id, { password: hash });
    res.json({ mensaje: "Contrasena actualizada correctamente." });
  } catch {
    res.status(400).json({ mensaje: "El enlace es invalido o ya expiro." });
  }
});

// ══════════════════════════════════════════
// RUTAS CIUDADANO
// ══════════════════════════════════════════
app.get("/perfil", verificarJWT, async (req, res) => {
  try { res.json(await Usuario.findById(req.user.id).select("-password")); }
  catch { res.status(500).json({ mensaje: "Error al obtener perfil" }); }
});

app.get("/api/puntos-limpios", verificarJWT, async (req, res) => {
  try { res.json(await PuntoLimpio.find({ activo: true })); }
  catch { res.status(500).json({ mensaje: "Error al obtener puntos limpios" }); }
});

app.get("/api/beneficios", verificarJWT, async (req, res) => {
  try { res.json(await Beneficio.find({ activo: true, stock: { $gt: 0 } })); }
  catch { res.status(500).json({ mensaje: "Error al obtener beneficios" }); }
});

app.get("/api/historial", verificarJWT, async (req, res) => {
  try { res.json(await Historial.find({ id_usuario: req.user.id }).sort({ fecha_actividad: -1 }).limit(50)); }
  catch { res.status(500).json({ mensaje: "Error al obtener historial" }); }
});

app.post("/api/reciclaje/qr", verificarJWT, async (req, res) => {
  try {
    const { tipo_material, cantidad, id_punto, codigo_qr, observaciones } = req.body;
    const punto = await PuntoLimpio.findOne({ _id: id_punto, codigo_qr, activo: true });
    if (!punto) return res.status(404).json({ mensaje: "QR o punto limpio invalido" });
    const pts = Math.max(5, Math.round((cantidad || 1) * 5));
    await new Historial({ id_usuario: req.user.id, id_punto: punto._id, nombre_punto: punto.nombre_punto, tipo_material, cantidad, puntos_ganados: pts, observaciones }).save();
    await Usuario.findByIdAndUpdate(req.user.id, { $inc: { puntos_totales: pts } });
    res.json({ mensaje: "Reciclaje registrado", puntos_ganados: pts });
  } catch (err) { res.status(500).json({ mensaje: "Error al registrar reciclaje" }); }
});

app.put("/api/historial/:id", verificarJWT, async (req, res) => {
  try {
    const { tipo_material, cantidad, observaciones } = req.body;
    const reg = await Historial.findById(req.params.id);
    if (!reg) return res.status(404).json({ mensaje: "Registro no encontrado" });
    if (reg.id_usuario.toString() !== req.user.id) return res.status(403).json({ mensaje: "Sin permisos" });
    const nuevos = Math.max(5, Math.round((cantidad || 1) * 5));
    const diff = nuevos - reg.puntos_ganados;
    reg.tipo_material = tipo_material; reg.cantidad = cantidad; reg.observaciones = observaciones; reg.puntos_ganados = nuevos;
    await reg.save();
    if (diff !== 0) await Usuario.findByIdAndUpdate(req.user.id, { $inc: { puntos_totales: diff } });
    res.json({ mensaje: "Reciclaje actualizado", registro: reg });
  } catch (err) { res.status(500).json({ mensaje: "Error al editar" }); }
});

app.delete("/api/historial/:id", verificarJWT, async (req, res) => {
  try {
    const reg = await Historial.findById(req.params.id);
    if (!reg) return res.status(404).json({ mensaje: "Registro no encontrado" });
    if (reg.id_usuario.toString() !== req.user.id) return res.status(403).json({ mensaje: "Sin permisos" });
    await Usuario.findByIdAndUpdate(req.user.id, { $inc: { puntos_totales: -reg.puntos_ganados } });
    await Historial.findByIdAndDelete(req.params.id);
    res.json({ mensaje: "Reciclaje eliminado", puntos_devueltos: reg.puntos_ganados });
  } catch (err) { res.status(500).json({ mensaje: "Error al eliminar" }); }
});

app.post("/api/canjes", verificarJWT, async (req, res) => {
  try {
    const { id_beneficio } = req.body;
    const ben = await Beneficio.findOne({ _id: id_beneficio, activo: true, stock: { $gt: 0 } });
    if (!ben) return res.status(400).json({ mensaje: "Beneficio no disponible" });
    const usr = await Usuario.findById(req.user.id);
    if (usr.puntos_totales < ben.puntos_requeridos) return res.status(400).json({ mensaje: "Puntos insuficientes" });
    await Usuario.findByIdAndUpdate(req.user.id, { $inc: { puntos_totales: -ben.puntos_requeridos } });
    await Beneficio.findByIdAndUpdate(id_beneficio, { $inc: { stock: -1 } });
    await new Canje({ id_usuario: req.user.id, id_beneficio, puntos_utilizados: ben.puntos_requeridos }).save();
    res.json({ mensaje: "Canje realizado con exito" });
  } catch (err) { res.status(500).json({ mensaje: "Error al realizar canje" }); }
});

// ══════════════════════════════════════════
// CRUD ADMIN: USUARIOS
// ══════════════════════════════════════════
app.get("/api/admin/usuarios", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol !== "admin") return res.status(403).json({ mensaje: "Sin permisos" });
    res.json(await Usuario.find().select("-password").sort({ fecha_registro: -1 }));
  } catch (err) { res.status(500).json({ mensaje: "Error al obtener usuarios" }); }
});

app.post("/api/admin/usuarios", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol !== "admin") return res.status(403).json({ mensaje: "Sin permisos" });
    const { nombre, correo, password, region, rol } = req.body;
    if (await Usuario.findOne({ correo })) return res.status(400).json({ mensaje: "Correo ya registrado" });
    const hash = password ? await bcrypt.hash(password, 12) : await bcrypt.hash("123456", 12);
    const nuevo = await new Usuario({ nombre, correo, password: hash, region, rol: rol || "ciudadano" }).save();
    res.status(201).json({ mensaje: "Usuario creado", usuario: nuevo });
  } catch (err) { res.status(500).json({ mensaje: "Error al crear usuario" }); }
});

app.put("/api/admin/usuarios/:id", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol !== "admin") return res.status(403).json({ mensaje: "Sin permisos" });
    const { nombre, correo, region, rol, activo } = req.body;
    const u = await Usuario.findByIdAndUpdate(req.params.id, { nombre, correo, region, rol, activo }, { new: true }).select("-password");
    res.json({ mensaje: "Usuario actualizado", usuario: u });
  } catch (err) { res.status(500).json({ mensaje: "Error al actualizar" }); }
});

app.put("/api/admin/usuarios/:id/estado", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol !== "admin") return res.status(403).json({ mensaje: "Sin permisos" });
    const { activo } = req.body;
    await Usuario.findByIdAndUpdate(req.params.id, { activo });
    res.json({ mensaje: activo ? "Usuario activado" : "Usuario bloqueado" });
  } catch (err) { res.status(500).json({ mensaje: "Error al actualizar estado" }); }
});

app.delete("/api/admin/usuarios/:id", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol !== "admin") return res.status(403).json({ mensaje: "Sin permisos" });
    await Usuario.findByIdAndDelete(req.params.id);
    res.json({ mensaje: "Usuario eliminado" });
  } catch (err) { res.status(500).json({ mensaje: "Error al eliminar" }); }
});

// ══════════════════════════════════════════
// CRUD ADMIN: PUNTOS LIMPIOS
// ══════════════════════════════════════════
app.get("/api/admin/puntos-limpios", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol !== "admin") return res.status(403).json({ mensaje: "Sin permisos" });
    res.json(await PuntoLimpio.find().sort({ _id: -1 }));
  } catch (err) { res.status(500).json({ mensaje: "Error al obtener puntos" }); }
});

app.post("/api/admin/puntos-limpios", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol !== "admin") return res.status(403).json({ mensaje: "Sin permisos" });
    const { nombre_punto, direccion, lat, lng, codigo_qr, materiales, activo } = req.body;
    const p = await new PuntoLimpio({ nombre_punto, direccion, lat, lng, codigo_qr, materiales, activo: activo !== false }).save();
    res.json({ mensaje: "Punto limpio creado", punto: p });
  } catch (err) { res.status(500).json({ mensaje: "Error al crear punto" }); }
});

app.put("/api/admin/puntos-limpios/:id", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol !== "admin") return res.status(403).json({ mensaje: "Sin permisos" });
    const { nombre_punto, direccion, lat, lng, codigo_qr, materiales, activo } = req.body;
    const p = await PuntoLimpio.findByIdAndUpdate(req.params.id, { nombre_punto, direccion, lat, lng, codigo_qr, materiales, activo }, { new: true });
    res.json({ mensaje: "Punto actualizado", punto: p });
  } catch (err) { res.status(500).json({ mensaje: "Error al actualizar" }); }
});

app.delete("/api/admin/puntos-limpios/:id", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol !== "admin") return res.status(403).json({ mensaje: "Sin permisos" });
    await PuntoLimpio.findByIdAndDelete(req.params.id);
    res.json({ mensaje: "Punto eliminado" });
  } catch (err) { res.status(500).json({ mensaje: "Error al eliminar" }); }
});

// ══════════════════════════════════════════
// CRUD ADMIN: BENEFICIOS
// ══════════════════════════════════════════
app.get("/api/admin/beneficios", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol !== "admin") return res.status(403).json({ mensaje: "Sin permisos" });
    res.json(await Beneficio.find().sort({ _id: -1 }));
  } catch (err) { res.status(500).json({ mensaje: "Error al obtener beneficios" }); }
});

app.post("/api/admin/beneficios", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol !== "admin") return res.status(403).json({ mensaje: "Sin permisos" });
    const { titulo, descripcion, puntos_requeridos, stock, activo } = req.body;
    const b = await new Beneficio({ titulo, descripcion, puntos_requeridos, stock, activo: activo !== false }).save();
    res.json({ mensaje: "Beneficio creado", beneficio: b });
  } catch (err) { res.status(500).json({ mensaje: "Error al crear beneficio" }); }
});

app.put("/api/admin/beneficios/:id", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol !== "admin") return res.status(403).json({ mensaje: "Sin permisos" });
    const { titulo, descripcion, puntos_requeridos, stock, activo } = req.body;
    const b = await Beneficio.findByIdAndUpdate(req.params.id, { titulo, descripcion, puntos_requeridos, stock, activo }, { new: true });
    res.json({ mensaje: "Beneficio actualizado", beneficio: b });
  } catch (err) { res.status(500).json({ mensaje: "Error al actualizar" }); }
});

app.delete("/api/admin/beneficios/:id", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol !== "admin") return res.status(403).json({ mensaje: "Sin permisos" });
    await Beneficio.findByIdAndDelete(req.params.id);
    res.json({ mensaje: "Beneficio eliminado" });
  } catch (err) { res.status(500).json({ mensaje: "Error al eliminar" }); }
});

// ══════════════════════════════════════════
// REPORTES ADMIN
// ══════════════════════════════════════════
app.get("/api/admin/historial", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol !== "admin") return res.status(403).json({ mensaje: "Sin permisos" });
    res.json(await Historial.find().populate("id_usuario", "nombre correo region").populate("id_punto", "nombre_punto").sort({ fecha_actividad: -1 }).limit(200));
  } catch (err) { res.status(500).json({ mensaje: "Error al obtener historial admin" }); }
});

app.get("/api/admin/canjes", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol !== "admin") return res.status(403).json({ mensaje: "Sin permisos" });
    res.json(await Canje.find().populate("id_usuario", "nombre correo").populate("id_beneficio", "titulo descripcion puntos_requeridos").sort({ fecha_canje: -1 }).limit(200));
  } catch (err) { res.status(500).json({ mensaje: "Error al obtener canjes admin" }); }
});

// ── Ruta raíz ──
app.get("/", (req, res) => { res.sendFile(path.join(__dirname, "index.html")); });

// ══════════════════════════════════════════
// ⚠️ INICIAR SERVIDOR — SIEMPRE AL FINAL
// ══════════════════════════════════════════
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Servidor en puerto", process.env.PORT || 3000);
  console.log("🌐 https://civiloopchile.onrender.com");
});