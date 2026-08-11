const express  = require("express");
const mongoose = require("mongoose");
const cors     = require("cors");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const path     = require("path");
const axios    = require("axios");
const { type } = require("os");
require("dotenv").config();
const { OAuth2Client } = require("google-auth-library");
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
// ── Catálogo único de materiales permitidos y su tarifa (pts/kg) ──
const MATERIALES_PERMITIDOS = {
  "Plástico": 5,
  "Vidrio":   3,
  "Papel y Cartón":   4,
  "Envases Tetra Pak":  5,
  "Metal y Aluminios":    8,
  "Electrónicos": 7
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

const PuntoLimpio = mongoose.model("PuntoLimpio", new mongoose.Schema({
  nombre_punto: { type: String, required: true },
  direccion:    { type: String, required: true },
  lat:          Number,
  lng:          Number,
  codigo_qr:    { type: String, unique: true },
  materiales:   [{ type: String, enum: Object.keys(MATERIALES_PERMITIDOS) }],
  activo:       { type: Boolean, default: true }
}));

const Empresa = mongoose.model("Empresa", new mongoose.Schema({
  nombre:         { type: String, required: true },
  rubro:          String,
  contacto_email: String,
  activo:         { type: Boolean, default: true }
}));

const Reto = mongoose.model("Reto", new mongoose.Schema({
  nombre:         { type: String, required: true },
  descripcion:    String,
  meta_kg:        { type: Number, required: true, min: 0.1 },
  puntos_premio:  { type: Number, required: true, min: 1 },
  material:       { type: String, enum: Object.keys(MATERIALES_PERMITIDOS), required: true },
  fecha_inicio:   { type: Date, required: true},
  fecha_fin:      { type: Date, required: true },
  id_empresa:     { type: mongoose.Schema.Types.ObjectId, ref: "Empresa", default: null},
  activo:         { type: Boolean, default: true }
}));

// 1. Declaras el esquema especificando la colección exacta de MongoDB
const beneficioSchema = new mongoose.Schema({
  titulo:            String,
  descripcion:       String,
  puntos_requeridos: { type: Number, required: true },
  stock:             { type: Number, default: 0 },
  id_empresa:        { type: mongoose.Schema.Types.ObjectId, ref: "Empresa", default: null },
  activo:            { type: Boolean, default: true }
}, { collection: "beneficios" }); // 👈 Especifica el nombre exacto de la colección

// 2. Creas el modelo usando ese esquema
const Beneficio = mongoose.model("Beneficio", beneficioSchema);

const Historial = mongoose.model("Historial", new mongoose.Schema({
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

const Canje = mongoose.model("Canje", new mongoose.Schema({
  id_usuario:        { type: mongoose.Schema.Types.ObjectId, ref: "Usuario" },
  id_beneficio:      { type: mongoose.Schema.Types.ObjectId, ref: "Beneficio" },
  puntos_utilizados: Number,
  fecha_canje:       { type: Date, default: Date.now },
  estado_canje:      { type: String, default: "pendiente" }
}));

const ProgresoReto = mongoose.model("ProgresoReto", new mongoose.Schema({
  id_usuario:       { type: mongoose.Schema.Types.ObjectId, ref: "Usuario", required: true },
  id_reto:          { type: mongoose.Schema.Types.ObjectId, ref:"Reto", required: true },
  kg_acumulados:    { type: Number, default: 0},
  completado:       { type: Boolean, default: false },
  fecha_completado: { type: Date, default:null },
}));
// Un usuario no podria tener dos progresos paa el mismo reto
ProgresoReto.schema.index({ id_usuario: 1, id_reto: 1}, { unique: true});

// ── POST /api/auth/google ──────────────────────────────────
app.post("/api/auth/google", async (req, res) => {
  const { credential } = req.body;

  try {
    // 1. Verificar el token recibido de Google
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { email, name } = payload;

    // 2. Buscar si el usuario ya existe usando el campo "correo"
    let usuario = await Usuario.findOne({ correo: email });

    if (!usuario) {
      // 3. Crear contraseña aleatoria encriptada (requerida por el schema)
      const passwordDummy = await bcrypt.hash(Math.random().toString(36), 12);

      usuario = new Usuario({
        nombre: name,
        correo: email,
        password: passwordDummy,
        region: "Google Auth",
        puntos_totales: 0,
        rol: "ciudadano"
      });
      await usuario.save();
    }

    if (!usuario.activo) {
      return res.status(403).json({ mensaje: "Cuenta bloqueada" });
    }

    // 4. Generar el JWT usando process.env.JWT_SECRET
    const token = jwt.sign(
      { id: usuario._id, correo: usuario.correo, rol: usuario.rol },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({
      mensaje: "Login con Google exitoso",
      token,
      usuario: {
        nombre:         usuario.nombre,
        correo:         usuario.correo,
        region:         usuario.region,
        rol:            usuario.rol,
        puntos_totales: usuario.puntos_totales
      }
    });

  } catch (error) {
    console.error("Error autenticando con Google:", error);
    res.status(401).json({ mensaje: "Token de Google inválido" });
  }
});
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
      return res.json({ mensaje: "Si el correo valido, recibiras un enlace." });

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
    const beneficios = await Beneficio.find({ activo: true, stock: { $gt: 0 } })
      .populate("id_empresa", "nombre rubro");
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

// PUT /api/historial/:id — el propio ciudadano edita su registro, solo mientras siga pendiente
app.put("/api/historial/:id", verificarJWT, async (req, res) => {
  try {
    const registro = await Historial.findOne({ _id: req.params.id, id_usuario: req.user.id });
    if (!registro) return res.status(404).json({ mensaje: "Registro no encontrado" });
    if (registro.estado !== "pendiente")
      return res.status(400).json({ mensaje: "Este registro ya fue validado y no se puede editar" });

    const { tipo_material, cantidad, observaciones } = req.body;
    if (!materialValido(tipo_material))
      return res.status(400).json({ mensaje: "Material no permitido" });
    const kilos = Number(cantidad);
    if (!Number.isFinite(kilos) || kilos <= 0)
      return res.status(400).json({ mensaje: "Cantidad de kilos invalida" });

    registro.tipo_material  = tipo_material;
    registro.cantidad       = kilos;
    registro.observaciones  = observaciones;
    registro.puntos_ganados = calcularPuntos(tipo_material, kilos);
    await registro.save();

    res.json({ mensaje: "Registro actualizado", registro });
  } catch (err) {
    console.log(err);
    res.status(500).json({ mensaje: "Error al actualizar registro" });
  }
});
app.get("/api/mis-retos", verificarJWT, async (req, res) => {
  try {
    const ahora = new Date();
    const retosVigentes = await Reto.find({ activo: true, fecha_fin: { $gte: ahora } });
    const progresos = await ProgresoReto.find({ id_usuario: req.user.id });

    const resultado = retosVigentes.map(reto => {
      const progreso = progresos.find(p => String(p.id_reto) === String(reto._id));
      return {
        reto,
        kg_acumulados: progreso ? progreso.kg_acumulados : 0,
        completado: progreso ? progreso.completado : false
      };
    });

    res.json(resultado);
  } catch (err) {
    console.log(err);
    res.status(500).json({ mensaje: "Error al obtener retos" });
  }
});
// DELETE /api/historial/:id — el propio ciudadano elimina su registro, solo mientras siga pendiente
app.delete("/api/historial/:id", verificarJWT, async (req, res) => {
  try {
    const registro = await Historial.findOne({ _id: req.params.id, id_usuario: req.user.id });
    if (!registro) return res.status(404).json({ mensaje: "Registro no encontrado" });
    if (registro.estado !== "pendiente")
      return res.status(400).json({ mensaje: "Este registro ya fue validado y no se puede eliminar" });
    await Historial.findByIdAndDelete(req.params.id);
    res.json({ mensaje: "Registro eliminado" });
  } catch (err) {
    console.log(err);
    res.status(500).json({ mensaje: "Error al eliminar registro" });
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
    const invalidos = (materiales || []).filter(m => !materialValido(m));
    if (invalidos.length)
      return res.status(400).json({ mensaje: `Material(es) no permitido(s): ${invalidos.join(", ")}. Validos: ${Object.keys(MATERIALES_PERMITIDOS).join(", ")}` });
    const nuevo = new PuntoLimpio({ nombre_punto, direccion, lat, lng, codigo_qr, materiales });
    await nuevo.save();
    res.json({ mensaje: "Punto limpio creado", punto: nuevo });
  } catch (err) {
    console.log("ERROR crear punto limpio:", err.message);
    res.status(500).json({ mensaje: "Error al crear punto limpio: " + err.message });
  }
});

// POST /api/admin/beneficios — crear beneficio
app.post("/api/admin/beneficios", verificarJWT, async (req, res) => {
  try {
    if (req.user.rol === "ciudadano")
      return res.status(403).json({ mensaje: "Sin permisos" });
    const { titulo, descripcion, puntos_requeridos, stock, id_empresa } = req.body;
    const nuevo = new Beneficio({ titulo, descripcion, puntos_requeridos, stock, id_empresa: id_empresa || null, activo: true });
    await nuevo.save();
    res.json({ mensaje: "Beneficio creado", beneficio: nuevo });
  } catch (err) {
    console.log("ERROR crear beneficio:", err.message);
    res.status(500).json({ mensaje: "Error al crear beneficio: " + err.message });
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
const ahora = new Date();
const retosAplicables = await Reto.find({
    activo:true,
    material: registro.tipo_material,
    fecha_inicio:{ $lte: ahora },
    fecha_fin:{ $gte: ahora }
});

for(const reto of retosAplicables){

    let progreso = await ProgresoReto.findOne({
        id_usuario: registro.id_usuario,
        id_reto: reto._id
    });

    if(!progreso){
        progreso = new ProgresoReto({
            id_usuario: registro.id_usuario,
            id_reto: reto._id
        });
    }

    if(progreso.completado)
        continue;

    progreso.kg_acumulados += registro.cantidad;

    if(progreso.kg_acumulados >= reto.meta_kg){

        progreso.completado = true;
        progreso.fecha_completado = ahora;

        await Usuario.findByIdAndUpdate(
            registro.id_usuario,
            {
                $inc:{
                    puntos_totales: reto.puntos_premio
                }
            }
        );

    }

    await progreso.save();

}
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
    const invalidos = (materiales || []).filter(m => !materialValido(m));
    if (invalidos.length)
      return res.status(400).json({ mensaje: `Material(es) no permitido(s): ${invalidos.join(", ")}. Validos: ${Object.keys(MATERIALES_PERMITIDOS).join(", ")}` });
    const actualizado = await PuntoLimpio.findByIdAndUpdate(
      req.params.id,
      { nombre_punto, direccion, lat, lng, codigo_qr, materiales },
      { new: true, runValidators: true }
    );
    if (!actualizado) return res.status(404).json({ mensaje: "Punto limpio no encontrado" });
    res.json({ mensaje: "Punto limpio actualizado", punto: actualizado });
  } catch (err) {
    console.log("ERROR actualizar punto limpio:", err.message);
    res.status(500).json({ mensaje: "Error al actualizar punto limpio: " + err.message });
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
    const beneficios = await Beneficio.find().populate("id_empresa", "nombre rubro").sort({ titulo: 1 });
    res.json(beneficios);
  } catch (err) {
    console.log("ERROR listar beneficios:", err.message);
    res.status(500).json({ mensaje: "Error al obtener beneficios: " + err.message });
  }
});

// PUT /api/admin/beneficios/:id — editar beneficio
app.put("/api/admin/beneficios/:id", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const { titulo, descripcion, puntos_requeridos, stock, id_empresa, activo } = req.body;
    const actualizado = await Beneficio.findByIdAndUpdate(
      req.params.id,
      { titulo, descripcion, puntos_requeridos, stock, id_empresa: id_empresa || null, activo },
      { new: true, runValidators: true }
    ).populate("id_empresa", "nombre rubro");
    if (!actualizado) return res.status(404).json({ mensaje: "Beneficio no encontrado" });
    res.json({ mensaje: "Beneficio actualizado", beneficio: actualizado });
  } catch (err) {
    console.log("ERROR actualizar beneficio:", err.message);
    res.status(500).json({ mensaje: "Error al actualizar beneficio: " + err.message });
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

// ══════════════════ CRUD: RETOS ══════════════════

app.get("/api/admin/retos", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const retos = await Reto.find().sort({ nombre: 1 });
    res.json(retos);
  } catch (err) {
    console.log("ERROR listar retos:", err.message);
    res.status(500).json({ mensaje: "Error al obtener retos: " + err.message });
  }
});

app.post("/api/admin/retos", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const { nombre, descripcion, meta_kg, puntos_premio, material, fecha_inicio, fecha_fin, id_empresa } = req.body;
    const meta = Number(meta_kg);
    const premio = Number(puntos_premio);

    if (!nombre) return res.status(400).json({ mensaje: "El nombre es obligatorio" });
    if (!Number.isFinite(meta) || meta <= 0) return res.status(400).json({ mensaje: "La meta en Kg debe ser mayor a 0" });
    if (!Number.isFinite(premio) || premio <= 0) return res.status(400).json({ mensaje: "Los puntos de premio deben ser mayor a 0" });
    if (!materialValido(material)) return res.status(400).json({ mensaje: "Material no permitido" });
    if (!fecha_inicio || !fecha_fin) return res.status(400).json({ mensaje: "Debes indicar fecha de inicio y fin" });
    if (new Date(fecha_inicio) >= new Date(fecha_fin))
      return res.status(400).json({ mensaje: "La fecha de inicio debe ser anterior a la fecha de fin" });

    const nuevo = await new Reto({
      nombre, descripcion, meta_kg: meta, puntos_premio: premio,
      material, fecha_inicio, fecha_fin, id_empresa: id_empresa || null, activo: true
    }).save();

    res.json({ mensaje: "Reto creado", reto: nuevo });
  } catch (err) {
    console.log("ERROR crear reto:", err.message);
    res.status(500).json({ mensaje: "Error al crear reto: " + err.message });
  }
});

app.put("/api/admin/retos/:id", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const { nombre, descripcion, meta_kg, puntos_premio, material, fecha_inicio, fecha_fin, id_empresa } = req.body;
    const meta = Number(meta_kg);
    const premio = Number(puntos_premio);

    if (!nombre) return res.status(400).json({ mensaje: "El nombre es obligatorio" });
    if (!Number.isFinite(meta) || meta <= 0) return res.status(400).json({ mensaje: "La meta en Kg debe ser mayor a 0" });
    if (!Number.isFinite(premio) || premio <= 0) return res.status(400).json({ mensaje: "Los puntos de premio deben ser mayor a 0" });
    if (!materialValido(material)) return res.status(400).json({ mensaje: "Material no permitido" });
    if (!fecha_inicio || !fecha_fin) return res.status(400).json({ mensaje: "Debes indicar fecha de inicio y fin" });
    if (new Date(fecha_inicio) >= new Date(fecha_fin))
      return res.status(400).json({ mensaje: "La fecha de inicio debe ser anterior a la fecha de fin" });

    const actualizado = await Reto.findByIdAndUpdate(
      req.params.id,
      { nombre, descripcion, meta_kg: meta, puntos_premio: premio, material, fecha_inicio, fecha_fin, id_empresa: id_empresa || null },
      { new: true, runValidators: true }
    );

    if (!actualizado) return res.status(404).json({ mensaje: "Reto no encontrado" });
    res.json({ mensaje: "Reto actualizado", reto: actualizado });
  } catch (err) {
    console.log("ERROR actualizar reto:", err.message);
    res.status(500).json({ mensaje: "Error al actualizar reto: " + err.message });
  }
});

app.put("/api/admin/retos/:id/estado", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const { activo } = req.body;
    const actualizado = await Reto.findByIdAndUpdate(req.params.id, { activo }, { new: true });
    if (!actualizado) return res.status(404).json({ mensaje: "Reto no encontrado" });
    res.json({ mensaje: "Estado actualizado", reto: actualizado });
  } catch (err) {
    res.status(500).json({ mensaje: "Error al actualizar estado: " + err.message });
  }
});

app.delete("/api/admin/retos/:id", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const borrado = await Reto.findByIdAndDelete(req.params.id);
    if (!borrado) return res.status(404).json({ mensaje: "Reto no encontrado" });
    res.json({ mensaje: "Reto eliminado" });
  } catch (err) {
    res.status(500).json({ mensaje: "Error al eliminar reto: " + err.message });
  }
});

// ══════════════════ CRUD: EMPRESAS ══════════════════

app.get("/api/admin/empresas", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const empresas = await Empresa.find().sort({ nombre: 1 });
    res.json(empresas);
  } catch (err) {
    console.log("ERROR listar empresas:", err.message);
    res.status(500).json({ mensaje: "Error al obtener empresas: " + err.message });
  }
});

app.post("/api/admin/empresas", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const { nombre, rubro, contacto_email } = req.body;
    if (!nombre) return res.status(400).json({ mensaje: "El nombre es obligatorio" });
    const nueva = await new Empresa({ nombre, rubro, contacto_email, activo: true }).save();
    res.json({ mensaje: "Empresa creada", empresa: nueva });
  } catch (err) {
    console.log("ERROR crear empresa:", err.message);
    res.status(500).json({ mensaje: "Error al crear empresa: " + err.message });
  }
});

app.put("/api/admin/empresas/:id", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const { nombre, rubro, contacto_email, activo } = req.body;
    if (!nombre) return res.status(400).json({ mensaje: "El nombre es obligatorio" });
    const actualizada = await Empresa.findByIdAndUpdate(
      req.params.id,
      { nombre, rubro, contacto_email, activo },
      { new: true, runValidators: true }
    );
    if (!actualizada) return res.status(404).json({ mensaje: "Empresa no encontrada" });
    res.json({ mensaje: "Empresa actualizada", empresa: actualizada });
  } catch (err) {
    console.log("ERROR actualizar empresa:", err.message);
    res.status(500).json({ mensaje: "Error al actualizar empresa: " + err.message });
  }
});

app.delete("/api/admin/empresas/:id", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const borrada = await Empresa.findByIdAndDelete(req.params.id);
    if (!borrada) return res.status(404).json({ mensaje: "Empresa no encontrada" });
    await Beneficio.updateMany({ id_empresa: req.params.id }, { id_empresa: null });
    res.json({ mensaje: "Empresa eliminada" });
  } catch (err) {
    console.log("ERROR eliminar empresa:", err.message);
    res.status(500).json({ mensaje: "Error al eliminar empresa: " + err.message });
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
app.put("/api/admin/canjes/:id/estado", verificarJWT, soloAdmin, async (req, res) => {
  try {
    const { estado_canje } = req.body; // "entregado" o "cancelado"
    if (!["entregado", "cancelado"].includes(estado_canje))
      return res.status(400).json({ mensaje: "Estado invalido" });

    const canje = await Canje.findById(req.params.id);
    if (!canje) return res.status(404).json({ mensaje: "Canje no encontrado" });
    if (canje.estado_canje !== "pendiente")
      return res.status(400).json({ mensaje: "Este canje ya fue procesado" });

    canje.estado_canje = estado_canje;
    await canje.save();

    if (estado_canje === "cancelado") {
      await Usuario.findByIdAndUpdate(canje.id_usuario, { $inc: { puntos_totales: canje.puntos_utilizados } });
      await Beneficio.findByIdAndUpdate(canje.id_beneficio, { $inc: { stock: 1 } });
    }

    res.json({ mensaje: `Canje ${estado_canje}`, canje });
  } catch (err) {
    console.log(err);
    res.status(500).json({ mensaje: "Error al actualizar canje" });
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