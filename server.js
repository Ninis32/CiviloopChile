const express  = require("express");
const mongoose = require("mongoose");
const cors     = require("cors");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const path     = require("path");
const axios    = require("axios");
require("dotenv").config();
// ── Catálogo único de materiales permitidos y su tarifa (pts/kg) ──
const MATERIALES_PERMITIDOS = {
  "Plástico": 5,
  "Vidrio":   3,
  "Papel":    4,
  "Cartón":   4,
  "Metal":    8,
  "Placas electronicas": 7
};

function materialValido(tipo) {
  return typeof tipo === "string" && Object.prototype.hasOwnProperty.call(MATERIALES_PERMITIDOS, tipo);
}

function calcularPuntos(tipo_material, cantidad) {
  const tarifa = MATERIALES_PERMITIDOS[tipo_material];
  return Math.round(tarifa * cantidad * 10) / 10; // 1 decimal
}
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
  punto_asignado: { type: mongoose.Schema.Types.ObjectId, ref: "PuntoLimpio" }, // solo para rol "trabajador"
  puntos_totales: { type: Number, default: 0 },
  fecha_registro: { type: Date,   default: Date.now },
  activo:         { type: Boolean, default: true }
}));

const puntoLimpio = mongoose.model("PuntoLimpio", new mongoose.Schema({
  nombre_punto: { type: String, required: true },
  direccion:    { type: String, required: true },
  lat:          Number,
  lng:          Number,
  codigo_qr:    { type: String, unique: true },
  materiales:   [{ type: String, enum: Object.keys(MATERIALES_PERMITIDOS) }],
  activo:       { type: Boolean, default: true }
}));

const beneficio = mongoose.model("Beneficio", new mongoose.Schema({
  titulo:            String,
  descripcion:       String,
  puntos_requeridos: { type: Number, required: true },
  stock:             { type: Number, default: 0 },
  activo:            { type: Boolean, default: true }
}));

const historials = mongoose.model("Historial", new mongoose.Schema({
  id_usuario:     { type: mongoose.Schema.Types.ObjectId, ref: "Usuario" },
  id_punto:       { type: mongoose.Schema.Types.ObjectId, ref: "PuntoLimpio" },
  nombre_punto:   String,
  tipo_material:  { type: String, enum: Object.keys(MATERIALES_PERMITIDOS), required: true },
  cantidad:       { type: Number, required: true, min: 0.1 },
  puntos_ganados: Number,
  observaciones:  String,
  estado:         { type: String, enum: ["pendiente", "aprobado", "rechazado"], default: "aprobado" },
  id_trabajador:  { type: mongoose.Schema.Types.ObjectId, ref: "Usuario" },
  fecha_actividad:{ type: Date, default: Date.now }
}));

const canje = mongoose.model("Canje", new mongoose.Schema({
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

    if (!materialValido(tipo_material))
      return res.status(400).json({ mensaje: "Material no permitido" });

    const kilos = Number(cantidad);
    if (!Number.isFinite(kilos) || kilos <= 0)
      return res.status(400).json({ mensaje: "Cantidad de kilos invalida" });

    const punto = await PuntoLimpio.findOne({ _id: id_punto, codigo_qr, activo: true });
    if (!punto) return res.status(404).json({ mensaje: "QR o punto limpio invalido" });
    if (!punto.materiales.includes(tipo_material))
      return res.status(400).json({ mensaje: "Este punto limpio no recibe ese material" });

    const puntos_ganados = calcularPuntos(tipo_material, kilos);

    const registro = await new Historial({
      id_usuario:   req.user.id,
      id_punto:     punto._id,
      nombre_punto: punto.nombre_punto,
      tipo_material, cantidad: kilos, puntos_ganados, observaciones,
      estado: "pendiente"
    }).save();

    // Los puntos NO se acreditan aqui: se acreditan cuando el trabajador aprueba
    res.json({ mensaje: "Reciclaje registrado, pendiente de validacion en el punto limpio", registro, puntos_ganados });
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

// DELETE /api/admin/usuarios/:id — eliminar usuario definitivamente
app.delete("/api/admin/usuarios/:id", verificarJWT, soloAdmin, async (req, res) => {
  try {
    // 1. Evitar que el administrador se elimine a sí mismo
    if (req.params.id === req.user.id) {
      return res.status(400).json({ mensaje: "No puedes eliminar tu propia cuenta de administrador" });
    }

    const usuarioBorrado = await Usuario.findByIdAndDelete(req.params.id);
    if (!usuarioBorrado) {
      return res.status(404).json({ mensaje: "Usuario no encontrado" });
    }

    res.json({ mensaje: "Usuario eliminado correctamente" });
  } catch (err) {
    console.log(err);
    res.status(500).json({ mensaje: "Error al eliminar usuario" });
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

// ── Middleware admin reutilizable ───────────────────────────
function soloAdmin(req, res, next) {
  if (req.user.rol === "ciudadano")
    return res.status(403).json({ mensaje: "Sin permisos" });
  next();
}

function soloTrabajador(req, res, next) {
  if (req.user.rol !== "trabajador" && req.user.rol !== "admin" && req.user.rol !== "administrador")
    return res.status(403).json({ mensaje: "Sin permisos" });
  next();
}

// ══════════════════ TRABAJADOR: validación en el punto limpio ══════════════════

// GET /api/trabajador/pendientes — reciclajes pendientes del punto asignado
app.get("/api/trabajador/pendientes", verificarJWT, soloTrabajador, async (req, res) => {
  try {
    const filtro = { estado: "pendiente" };
    if (req.user.rol === "trabajador") {
      const yo = await Usuario.findById(req.user.id);
      if (!yo.punto_asignado) return res.status(400).json({ mensaje: "No tienes un punto limpio asignado" });
      filtro.id_punto = yo.punto_asignado;
    }
    const pendientes = await Historial.find(filtro)
      .populate("id_usuario", "nombre correo")
      .sort({ fecha_actividad: 1 });
    res.json(pendientes);
  } catch (err) {
    console.log(err);
    res.status(500).json({ mensaje: "Error al obtener pendientes" });
  }
});

// GET /api/trabajador/historial — historial ya procesado del punto asignado
app.get("/api/trabajador/historial", verificarJWT, soloTrabajador, async (req, res) => {
  try {
    const filtro = { estado: { $in: ["aprobado", "rechazado"] } };
    if (req.user.rol === "trabajador") {
      const yo = await Usuario.findById(req.user.id);
      if (!yo.punto_asignado) return res.status(400).json({ mensaje: "No tienes un punto limpio asignado" });
      filtro.id_punto = yo.punto_asignado;
    }
    const historial = await Historial.find(filtro)
      .populate("id_usuario", "nombre correo")
      .sort({ fecha_actividad: -1 })
      .limit(50);
    res.json(historial);
  } catch (err) {
    console.log(err);
    res.status(500).json({ mensaje: "Error al obtener historial" });
  }
});

// PUT /api/trabajador/historial/:id/aprobar — confirma el reciclaje; recien aqui se acreditan los puntos
app.put("/api/trabajador/historial/:id/aprobar", verificarJWT, soloTrabajador, async (req, res) => {
  try {
    const registro = await Historial.findById(req.params.id);
    if (!registro) return res.status(404).json({ mensaje: "Registro no encontrado" });
    if (registro.estado !== "pendiente")
      return res.status(400).json({ mensaje: "Este registro ya fue procesado" });

    if (req.user.rol === "trabajador") {
      const yo = await Usuario.findById(req.user.id);
      if (!yo.punto_asignado || String(yo.punto_asignado) !== String(registro.id_punto))
        return res.status(403).json({ mensaje: "No estas asignado a este punto limpio" });
    }

    registro.estado = "aprobado";
    registro.id_trabajador = req.user.id;
    await registro.save();
    await Usuario.findByIdAndUpdate(registro.id_usuario, { $inc: { puntos_totales: registro.puntos_ganados } });

    res.json({ mensaje: "Reciclaje aprobado", registro });
  } catch (err) {
    console.log(err);
    res.status(500).json({ mensaje: "Error al aprobar reciclaje" });
  }
});

// PUT /api/trabajador/historial/:id/rechazar — descarta el registro, no se acreditan puntos
app.put("/api/trabajador/historial/:id/rechazar", verificarJWT, soloTrabajador, async (req, res) => {
  try {
    const registro = await Historial.findById(req.params.id);
    if (!registro) return res.status(404).json({ mensaje: "Registro no encontrado" });
    if (registro.estado !== "pendiente")
      return res.status(400).json({ mensaje: "Este registro ya fue procesado" });

    if (req.user.rol === "trabajador") {
      const yo = await Usuario.findById(req.user.id);
      if (!yo.punto_asignado || String(yo.punto_asignado) !== String(registro.id_punto))
        return res.status(403).json({ mensaje: "No estas asignado a este punto limpio" });
    }

    registro.estado = "rechazado";
    registro.id_trabajador = req.user.id;
    await registro.save();
    res.json({ mensaje: "Reciclaje rechazado", registro });
  } catch (err) {
    console.log(err);
    res.status(500).json({ mensaje: "Error al rechazar reciclaje" });
  }
});

// ══════════════════ CRUD: PUNTOS LIMPIOS ══════════════════

// GET /api/admin/puntos-limpios — listar TODOS (activos e inactivos)
app.get("/api/admin/puntos-limpios", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const puntos = await PuntoLimpio.find().sort({ nombre_punto: 1 });
    res.json(puntos);
  } catch {
    res.status(500).json({ mensaje: "Error al obtener puntos limpios" });
  }
});

// PUT /api/admin/puntos-limpios/:id — editar punto limpio
app.put("/api/admin/puntos-limpios/:id", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const { nombre_punto, direccion, lat, lng, codigo_qr, materiales } = req.body;
    const actualizado = await PuntoLimpio.findByIdAndUpdate(
      req.params.id,
      { nombre_punto, direccion, lat, lng, codigo_qr, materiales },
      { new: true }
    );
    if (!actualizado) return res.status(404).json({ mensaje: "Punto limpio no encontrado" });
    res.json({ mensaje: "Punto limpio actualizado", punto: actualizado });
  } catch {
    res.status(500).json({ mensaje: "Error al actualizar punto limpio" });
  }
});

// PUT /api/admin/puntos-limpios/:id/estado — activar / desactivar
app.put("/api/admin/puntos-limpios/:id/estado", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const { activo } = req.body;
    await PuntoLimpio.findByIdAndUpdate(req.params.id, { activo });
    res.json({ mensaje: activo ? "Punto limpio activado" : "Punto limpio desactivado" });
  } catch {
    res.status(500).json({ mensaje: "Error al actualizar estado" });
  }
});

// DELETE /api/admin/puntos-limpios/:id — eliminar definitivamente
app.delete("/api/admin/puntos-limpios/:id", verificarJWT, soloAdmin, async (req, res) => {
  try {
    await PuntoLimpio.findByIdAndDelete(req.params.id);
    res.json({ mensaje: "Punto limpio eliminado" });
  } catch {
    res.status(500).json({ mensaje: "Error al eliminar punto limpio" });
  }
});

// ══════════════════ CRUD: BENEFICIOS ══════════════════

// GET /api/admin/beneficios — listar TODOS (activos, inactivos y sin stock)
app.get("/api/admin/beneficios", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const beneficios = await Beneficio.find().sort({ titulo: 1 });
    res.json(beneficios);
  } catch {
    res.status(500).json({ mensaje: "Error al obtener beneficios" });
  }
});

// PUT /api/admin/beneficios/:id — editar beneficio
app.put("/api/admin/beneficios/:id", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const { titulo, descripcion, puntos_requeridos, stock, activo } = req.body;
    const actualizado = await Beneficio.findByIdAndUpdate(
      req.params.id,
      { titulo, descripcion, puntos_requeridos, stock, activo },
      { new: true }
    );
    if (!actualizado) return res.status(404).json({ mensaje: "Beneficio no encontrado" });
    res.json({ mensaje: "Beneficio actualizado", beneficio: actualizado });
  } catch {
    res.status(500).json({ mensaje: "Error al actualizar beneficio" });
  }
});

// DELETE /api/admin/beneficios/:id — eliminar definitivamente
app.delete("/api/admin/beneficios/:id", verificarJWT, soloAdmin, async (req, res) => {
  try {
    await Beneficio.findByIdAndDelete(req.params.id);
    res.json({ mensaje: "Beneficio eliminado" });
  } catch {
    res.status(500).json({ mensaje: "Error al eliminar beneficio" });
  }
});

// ══════════════════ CRUD: RECICLAJE (Historial) ══════════════════

// GET /api/admin/historial — listar TODOS los reciclajes, con datos del usuario
app.get("/api/admin/historial", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const historial = await Historial.find()
      .populate("id_usuario", "nombre correo")
      .sort({ fecha_actividad: -1 });
    res.json(historial);
  } catch {
    res.status(500).json({ mensaje: "Error al obtener historial" });
  }
});

// POST /api/admin/historial — registrar reciclaje manualmente (a nombre de un usuario)
app.post("/api/admin/historial", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const { id_usuario, id_punto, tipo_material, cantidad, observaciones } = req.body;

    if (!materialValido(tipo_material))
      return res.status(400).json({ mensaje: "Material no permitido" });
    const kilos = Number(cantidad);
    if (!Number.isFinite(kilos) || kilos <= 0)
      return res.status(400).json({ mensaje: "Cantidad de kilos invalida" });

    const usuario = await Usuario.findById(id_usuario);
    if (!usuario) return res.status(404).json({ mensaje: "Usuario no encontrado" });
    let nombre_punto = "Registro manual";
    if (id_punto) {
      const punto = await PuntoLimpio.findById(id_punto);
      if (punto) nombre_punto = punto.nombre_punto;
    }
    const puntos_ganados = calcularPuntos(tipo_material, kilos);
    const nuevo = await new Historial({
      id_usuario, id_punto: id_punto || undefined, nombre_punto,
      tipo_material, cantidad: kilos, puntos_ganados, observaciones,
      estado: "aprobado", id_trabajador: req.user.id
    }).save();
    await Usuario.findByIdAndUpdate(id_usuario, { $inc: { puntos_totales: puntos_ganados } });
    res.json({ mensaje: "Reciclaje registrado", historial: nuevo });
  } catch (err) {
    console.log(err);
    res.status(500).json({ mensaje: "Error al registrar reciclaje" });
  }
});

// PUT /api/admin/historial/:id — editar un registro de reciclaje
// Ajusta los puntos del usuario por la diferencia entre el valor anterior y el nuevo.
app.put("/api/admin/historial/:id", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const anterior = await Historial.findById(req.params.id);
    if (!anterior) return res.status(404).json({ mensaje: "Registro no encontrado" });

    const { tipo_material, cantidad, observaciones } = req.body;
    if (!materialValido(tipo_material))
      return res.status(400).json({ mensaje: "Material no permitido" });
    const kilos = Number(cantidad);
    if (!Number.isFinite(kilos) || kilos <= 0)
      return res.status(400).json({ mensaje: "Cantidad de kilos invalida" });

    const nuevos_puntos = calcularPuntos(tipo_material, kilos);
    const diferencia = nuevos_puntos - (anterior.estado === "aprobado" ? anterior.puntos_ganados : 0);

    anterior.tipo_material  = tipo_material;
    anterior.cantidad       = kilos;
    anterior.observaciones  = observaciones;
    anterior.puntos_ganados = nuevos_puntos;
    await anterior.save();

    if (anterior.estado === "aprobado" && diferencia !== 0) {
      await Usuario.findByIdAndUpdate(anterior.id_usuario, { $inc: { puntos_totales: diferencia } });
    }
    res.json({ mensaje: "Reciclaje actualizado", historial: anterior });
  } catch {
    res.status(500).json({ mensaje: "Error al actualizar reciclaje" });
  }
});

// DELETE /api/admin/historial/:id — eliminar registro y descontar los puntos otorgados
app.delete("/api/admin/historial/:id", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const registro = await Historial.findById(req.params.id);
    if (!registro) return res.status(404).json({ mensaje: "Registro no encontrado" });
    if (registro.estado === "aprobado") {
      await Usuario.findByIdAndUpdate(registro.id_usuario, { $inc: { puntos_totales: -registro.puntos_ganados } });
    }
    await Historial.findByIdAndDelete(req.params.id);
    res.json({ mensaje: "Reciclaje eliminado y puntos descontados" });
  } catch {
    res.status(500).json({ mensaje: "Error al eliminar reciclaje" });
  }
});

// GET /api/admin/canjes — listar todos los canjes, con datos del usuario y beneficio
app.get("/api/admin/canjes", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const canjes = await Canje.find()
      .populate("id_usuario", "nombre correo")
      .populate("id_beneficio", "titulo")
      .sort({ fecha_canje: -1 });
    res.json(canjes);
  } catch {
    res.status(500).json({ mensaje: "Error al obtener canjes" });
  }
});

// ══════════════════ CRUD: USUARIOS (crear / editar / eliminar) ══════════════════

// POST /api/admin/usuarios — crear usuario directamente desde el panel admin
app.post("/api/admin/usuarios", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const { nombre, correo, password, region, rol } = req.body;
    if (!nombre || !correo || !password)
      return res.status(400).json({ mensaje: "Nombre, correo y contraseña son obligatorios" });
    if (await Usuario.findOne({ correo }))
      return res.status(400).json({ mensaje: "El correo ya está registrado" });
    const hash  = await bcrypt.hash(password, 12);
    const nuevo = await new Usuario({ nombre, correo, password: hash, region: region || "—", rol: rol || "ciudadano" }).save();
    res.json({ mensaje: "Usuario creado", usuario: { ...nuevo.toObject(), password: undefined } });
  } catch (err) {
    console.log(err);
    res.status(500).json({ mensaje: "Error al crear usuario" });
  }
});

// PUT /api/admin/usuarios/:id — editar datos completos del usuario
app.put("/api/admin/usuarios/:id", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const { nombre, correo, region, rol, punto_asignado } = req.body;
    if (rol === "trabajador" && !punto_asignado)
      return res.status(400).json({ mensaje: "Debes asignar un punto limpio al trabajador" });
    if (correo) {
      const existente = await Usuario.findOne({ correo, _id: { $ne: req.params.id } });
      if (existente) return res.status(400).json({ mensaje: "Ese correo ya lo usa otro usuario" });
    }
    const actualizado = await Usuario.findByIdAndUpdate(
      req.params.id,
      { nombre, correo, region, rol, punto_asignado: rol === "trabajador" ? punto_asignado : null },
      { new: true }
    ).select("-password");
    if (!actualizado) return res.status(404).json({ mensaje: "Usuario no encontrado" });
    res.json({ mensaje: "Usuario actualizado", usuario: actualizado });
  } catch {
    res.status(500).json({ mensaje: "Error al actualizar usuario" });
  }
});

// DELETE /api/admin/usuarios/:id — eliminar usuario definitivamente
app.delete("/api/admin/usuarios/:id", verificarJWT, soloAdmin, async (req, res) => {
  try {
    if (req.params.id === req.user.id)
      return res.status(400).json({ mensaje: "No puedes eliminar tu propia cuenta" });
    await Usuario.findByIdAndDelete(req.params.id);
    res.json({ mensaje: "Usuario eliminado" });
  } catch {
    res.status(500).json({ mensaje: "Error al eliminar usuario" });
  }
});