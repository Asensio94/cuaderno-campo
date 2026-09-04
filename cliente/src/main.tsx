// Punto de entrada. Dos pantallas y un enrutado de tres líneas: la aplicación, y el
// diagnóstico del almacén en `#/conformidad`, que se queda porque es lo único que comprueba el
// almacén sobre OPFS de verdad y hay que poder correrlo en el aparato que se lleva al monte.

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './estilo.css';

import { Aplicacion } from './aplicacion.tsx';
import { Diagnostico } from './pantalla-diagnostico.tsx';

function Raiz() {
  const [ruta, setRuta] = useState(location.hash);
  useEffect(() => {
    const cambio = () => setRuta(location.hash);
    addEventListener('hashchange', cambio);
    return () => removeEventListener('hashchange', cambio);
  }, []);

  return <main>{ruta === '#/conformidad' ? <Diagnostico /> : <Aplicacion />}</main>;
}

// Sin StrictMode: monta cada efecto dos veces y aquí eso es abrir dos veces el mismo almacén y
// correr el diagnóstico por duplicado. Volverá cuando haya estado que merezca esa red.
createRoot(document.getElementById('raiz')!).render(<Raiz />);
