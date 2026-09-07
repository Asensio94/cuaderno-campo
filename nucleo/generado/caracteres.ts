// GENERADO. No editar a mano.
//
// Fuente:    nucleo/caracteres.toml
// Regenerar: python -m nucleo.generadores generar
// Verificar: python -m nucleo.generadores verificar
//
// Caracteres macroscópicos de campo (ADR-0001 §15.20). Viajan dentro de dwc:dynamicProperties,
// bajo la clave de su grupo. El formulario se pinta recorriendo CARACTERES.

export type TipoCaracter = 'opcion' | 'texto' | 'entero';

export interface OpcionCaracter {
  readonly clave: string;
  readonly etiqueta: string;
}

export interface Caracter {
  readonly clave: string;
  readonly etiqueta: string;
  readonly tipo: TipoCaracter;
  readonly nota?: string;
  readonly opciones?: readonly OpcionCaracter[];
}

export interface GrupoCaracteres {
  readonly clave: string;
  readonly etiqueta: string;
  readonly nota?: string;
  readonly caracteres: readonly Caracter[];
}

export const VERSION_CARACTERES = 1;

export const CARACTERES: readonly GrupoCaracteres[] = [
  {
    "clave": "hongo",
    "etiqueta": "Hongo",
    "nota": "Caracteres macroscópicos del cuerpo fructífero, en el orden en que se miran en el campo.",
    "caracteres": [
      {
        "clave": "himenoforo",
        "etiqueta": "Himenóforo",
        "tipo": "opcion",
        "opciones": [
          {
            "clave": "laminas",
            "etiqueta": "Láminas"
          },
          {
            "clave": "poros",
            "etiqueta": "Poros"
          },
          {
            "clave": "pliegues",
            "etiqueta": "Pliegues"
          },
          {
            "clave": "aguijones",
            "etiqueta": "Aguijones"
          },
          {
            "clave": "liso",
            "etiqueta": "Liso"
          },
          {
            "clave": "otro",
            "etiqueta": "Otro"
          }
        ]
      },
      {
        "clave": "insercion",
        "etiqueta": "Inserción de las láminas",
        "tipo": "opcion",
        "nota": "Cómo llegan las láminas al pie. Solo si hay láminas.",
        "opciones": [
          {
            "clave": "libres",
            "etiqueta": "Libres"
          },
          {
            "clave": "adnatas",
            "etiqueta": "Adnatas"
          },
          {
            "clave": "escotadas",
            "etiqueta": "Escotadas"
          },
          {
            "clave": "decurrentes",
            "etiqueta": "Decurrentes"
          }
        ]
      },
      {
        "clave": "anillo",
        "etiqueta": "Anillo",
        "tipo": "opcion",
        "opciones": [
          {
            "clave": "ausente",
            "etiqueta": "Ausente"
          },
          {
            "clave": "presente",
            "etiqueta": "Presente"
          },
          {
            "clave": "cortina",
            "etiqueta": "Cortina"
          },
          {
            "clave": "fugaz",
            "etiqueta": "Restos fugaces"
          }
        ]
      },
      {
        "clave": "volva",
        "etiqueta": "Volva",
        "tipo": "opcion",
        "nota": "Hay que desenterrar la base del pie para verla.",
        "opciones": [
          {
            "clave": "ausente",
            "etiqueta": "Ausente"
          },
          {
            "clave": "presente",
            "etiqueta": "Presente"
          }
        ]
      },
      {
        "clave": "viraje",
        "etiqueta": "Viraje al corte o al roce",
        "tipo": "opcion",
        "opciones": [
          {
            "clave": "ninguno",
            "etiqueta": "Ninguno"
          },
          {
            "clave": "azul",
            "etiqueta": "Azul"
          },
          {
            "clave": "rojo",
            "etiqueta": "Rojo"
          },
          {
            "clave": "negro",
            "etiqueta": "Negro"
          },
          {
            "clave": "amarillo",
            "etiqueta": "Amarillo"
          },
          {
            "clave": "verde",
            "etiqueta": "Verde"
          },
          {
            "clave": "otro",
            "etiqueta": "Otro"
          }
        ]
      },
      {
        "clave": "viraje_intensidad",
        "etiqueta": "Cuánto vira",
        "tipo": "opcion",
        "nota": "Solo si vira.",
        "opciones": [
          {
            "clave": "leve",
            "etiqueta": "Leve"
          },
          {
            "clave": "moderado",
            "etiqueta": "Moderado"
          },
          {
            "clave": "fuerte",
            "etiqueta": "Fuerte"
          }
        ]
      },
      {
        "clave": "latex",
        "etiqueta": "Látex",
        "tipo": "opcion",
        "opciones": [
          {
            "clave": "ninguno",
            "etiqueta": "Ninguno"
          },
          {
            "clave": "blanco",
            "etiqueta": "Blanco"
          },
          {
            "clave": "coloreado",
            "etiqueta": "Coloreado"
          },
          {
            "clave": "acuoso",
            "etiqueta": "Acuoso"
          }
        ]
      },
      {
        "clave": "sustrato",
        "etiqueta": "Sustrato",
        "tipo": "opcion",
        "opciones": [
          {
            "clave": "suelo",
            "etiqueta": "Suelo"
          },
          {
            "clave": "madera",
            "etiqueta": "Madera"
          },
          {
            "clave": "hojarasca",
            "etiqueta": "Hojarasca"
          },
          {
            "clave": "estiercol",
            "etiqueta": "Estiércol"
          },
          {
            "clave": "musgo",
            "etiqueta": "Musgo"
          },
          {
            "clave": "otro",
            "etiqueta": "Otro"
          }
        ]
      },
      {
        "clave": "color_sombrero",
        "etiqueta": "Color del sombrero",
        "tipo": "texto"
      },
      {
        "clave": "color_pie",
        "etiqueta": "Color del pie",
        "tipo": "texto"
      },
      {
        "clave": "color_himenoforo",
        "etiqueta": "Color del himenóforo",
        "tipo": "texto"
      },
      {
        "clave": "sombrero_mm",
        "etiqueta": "Sombrero (mm)",
        "tipo": "entero",
        "nota": "Diámetro del sombrero."
      },
      {
        "clave": "olor",
        "etiqueta": "Olor",
        "tipo": "texto"
      },
      {
        "clave": "esporada",
        "etiqueta": "Esporada",
        "tipo": "texto",
        "nota": "El color, y se sabe al día siguiente: se apunta como enmienda."
      }
    ]
  }
];

export interface CaracteresHongo {
  readonly himenoforo?: 'laminas' | 'poros' | 'pliegues' | 'aguijones' | 'liso' | 'otro';
  readonly insercion?: 'libres' | 'adnatas' | 'escotadas' | 'decurrentes';
  readonly anillo?: 'ausente' | 'presente' | 'cortina' | 'fugaz';
  readonly volva?: 'ausente' | 'presente';
  readonly viraje?: 'ninguno' | 'azul' | 'rojo' | 'negro' | 'amarillo' | 'verde' | 'otro';
  readonly viraje_intensidad?: 'leve' | 'moderado' | 'fuerte';
  readonly latex?: 'ninguno' | 'blanco' | 'coloreado' | 'acuoso';
  readonly sustrato?: 'suelo' | 'madera' | 'hojarasca' | 'estiercol' | 'musgo' | 'otro';
  readonly color_sombrero?: string;
  readonly color_pie?: string;
  readonly color_himenoforo?: string;
  readonly sombrero_mm?: number;
  readonly olor?: string;
  readonly esporada?: string;
}

/** El valor de dwc:dynamicProperties: un objeto por grupo, y solo los grupos que se
 * apuntaron. */
export interface PropiedadesDinamicas {
  readonly hongo?: CaracteresHongo;
}
