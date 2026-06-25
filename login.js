document.getElementById("loginForm").addEventListener("submit", async (e) => {

    e.preventDefault();

    const correo = document.getElementById("correo").value;
    const password = document.getElementById("password").value;

    const respuesta = await fetch("http://localhost:3000/login", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            correo,
            password
        })
    });

    const datos = await respuesta.json();
    console.log("STATUS:", respuesta.status);
    console.log("DATOS:", datos);

    if (respuesta.ok) {
        alert("Bienvenido");
        window.location = "dashboard.html";
    } else {
        alert(datos.mensaje);
    }

});