document.getElementById("registroForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const nombre = document.getElementById("nombre").value;
    const correo = document.getElementById("correo").value;
    const password = document.getElementById("password").value;
    const region = document.getElementById("region").value;

    const respuesta = await fetch("http://localhost:3000/registro", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            nombre,
            correo,
            password,
            region
        })
    });

    const datos = await respuesta.json();
    if(respuesta.ok){
        alert("Usuario registrado correctamente");
        windows.location = "index.html";
    } else{
        alert(datos.mensaje);
    }
});