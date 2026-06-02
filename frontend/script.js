async function CPUUpdate() {
    const reponse = await fetch("http://localhost:8000/server/system");
    const data = await reponse.json();
    document.getElementById("cpu").innerText = `CPU: ${data.cpu}%`;
    document.getElementById("memory").innerText = `Memory: ${data.memory}%`;
    
}
CPUUpdate();
setInterval(CPUUpdate, 2000);