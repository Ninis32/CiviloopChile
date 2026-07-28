const API = window.location.port === "5500" || window.location.port === "5501"
  ? "https://civiloopchile.onrender.com"
  : "";

// Formulario de Inicio de Sesión Principal
document.querySelector("form").addEventListener("submit", async (e) => {
  e.preventDefault();

  const correo   = document.getElementById("correo").value;
  const password = document.getElementById("password").value;
  const btn      = document.querySelector(".btn-login");

  btn.textContent = "Entrando...";
  btn.disabled    = true;

  try {
    const res  = await fetch(API + "/login", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ correo, password })
    });

    const datos = await res.json();
    console.log("ROL:", datos.usuario?.rol); // para verificar el rol

    if (datos.token) {
      localStorage.setItem("token",   datos.token);
      localStorage.setItem("usuario", JSON.stringify(datos.usuario));

      const rol = datos.usuario.rol;
      
      // Redirección inteligente según el ROL del usuario
      if (rol === "admin" || rol === "administrador") {
        window.location.href = "admin-dashboard.html";
      } else if (rol === "trabajador" || rol === "empresa") {
        window.location.href = "trabajador-dashboard.html"; //  Trabajador/Empresa
      } else {
        window.location.href = "dashboard.html"; // Ciudadano
      }
    } else {
      alert(datos.mensaje || "Error al iniciar sesión");
      btn.textContent = "Entrar";
      btn.disabled    = false;
    }

  } catch (error) {
    console.error(error);
    alert("Error de conexión. Verifica que node server.js esté corriendo.");
    btn.textContent = "Entrar";
    btn.disabled    = false;
  }
});

// Botón secundario "Entrar como Administrador" (opcional)
const btnAdmin = document.querySelector(".btn-admin");
if (btnAdmin) {
  btnAdmin.addEventListener("click", async () => {
    const correo   = document.getElementById("correo").value;
    const password = document.getElementById("password").value;

    if (!correo || !password) {
      alert("Ingresa tu correo y contraseña primero");
      return;
    }

    try {
      const res  = await fetch(API + "/login", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ correo, password })
      });

      const datos = await res.json();
      console.log("ROL ADMIN:", datos.usuario?.rol);

      if (datos.token) {
        const rol = datos.usuario.rol;
        
        if (rol === "ciudadano") {
          alert("No tienes permisos de administración o gestión");
          return;
        }

        localStorage.setItem("token",   datos.token);
        localStorage.setItem("usuario", JSON.stringify(datos.usuario));

        if (rol === "trabajador" || rol === "empresa") {
          window.location.href = "trabajador-dashboard.html";
        } else {
          window.location.href = "admin-dashboard.html";
        }
      } else {
        alert(datos.mensaje || "Credenciales incorrectas");
      }
    } catch {
      alert("Error de conexión");
    }
  });
}
