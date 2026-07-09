document.getElementById("registroForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const btn = document.querySelector("button[type='submit']") || document.querySelector(".btn-login");
  btn.textContent = "Registrando...";
  btn.disabled    = true;

  const nombre   = document.getElementById("nombre").value;
  const correo   = document.getElementById("correo").value;
  const password = document.getElementById("password").value;
  const region   = document.getElementById("region").value;

  try {
    const res   = await fetch("https://civiloopchile.onrender.com/registro", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ nombre, correo, password, region })
    });

    const datos = await res.json();

    if (res.ok) {
      alert("Cuenta creada correctamente. Ahora inicia sesion.");
      window.location.href = "index.html"; // redirige al login
    } else {
      alert(datos.mensaje);
      btn.textContent = "Registrarse";
      btn.disabled    = false;
    }

  } catch (error) {
    alert("Error de conexion con el servidor.");
    btn.textContent = "Registrarse";
    btn.disabled    = false;
  }
});
