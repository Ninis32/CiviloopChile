const API = window.location.port === "5500" || window.location.port === "5501"
  ? "http://localhost:3000"
  : "";

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
      if (rol === "admin" || rol === "administrador") {
        window.location.href = "admin-dashboard.html";
      } else {
        window.location.href = "dashboard.html";
      }
    } else {
      alert(datos.mensaje || "Error al iniciar sesion");
      btn.textContent = "Entrar";
      btn.disabled    = false;
    }

  } catch {
    alert("Error de conexion. Verifica que node server.js esta corriendo.");
    btn.textContent = "Entrar";
    btn.disabled    = false;
  }
});

// Boton "Entrar como Administrador"
const btnAdmin = document.querySelector(".btn-admin");
if (btnAdmin) {
  btnAdmin.addEventListener("click", async () => {
    const correo   = document.getElementById("correo").value;
    const password = document.getElementById("password").value;

    if (!correo || !password) {
      alert("Ingresa tu correo y contrasena primero");
      return;
    }

    try {
      const res  = await fetch(API + "/login", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ correo, password })
      });

      const datos = await res.json();
      console.log("ROL ADMIN:", datos.usuario?.rol); // para verificar

      if (datos.token) {
        const rol = datos.usuario.rol;
        // Acepta cualquier rol que no sea ciudadano
        if (rol === "ciudadano") {
          alert("No tienes permisos de administrador");
          return;
        }
        localStorage.setItem("token",   datos.token);
        localStorage.setItem("usuario", JSON.stringify(datos.usuario));
        window.location.href = "admin-login.html";
      } else {
        alert(datos.mensaje || "Credenciales incorrectas");
      }
    } catch {
      alert("Error de conexion");
    }
  });
}
