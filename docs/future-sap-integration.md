# Futuro — Integración SAP modo lectura (Fase 4)

## Objetivo

Permitir al agente consultar datos reales de SAP S/4HANA / ECC en modo **lectura**, sin capacidad de escritura ni ejecución de transacciones que modifiquen datos.

## Canales soportados (en orden de preferencia)

1. **OData v2/v4** — para S/4HANA Cloud y on-prem con Gateway expuesto.
2. **CDS Views** vía OData — recomendado para reporting.
3. **SAP Integration Suite / BTP destinations** — autenticación centralizada.
4. **RFC de lectura** vía SAP NWRFC (Node connector) — para ECC clásico.
5. **BAPI de lectura** (`BAPI_*_GETDETAIL`, `BAPI_*_GETLIST`).

## Catálogo blanco (whitelist)

Solo endpoints/RFC marcados como **read-only**:

| Dominio | Tabla / Endpoint | Uso |
|---|---|---|
| MM | `API_PURCHASEORDER_PROCESS_SRV` (read), EKKO, EKPO | OC y posiciones |
| MM | EKBE, MSEG | Historial y movimientos |
| SD | `API_SALES_ORDER_SRV` (read), VBAK, VBAP | Pedido venta |
| SD | LIKP, LIPS, VBRK, VBRP | Entregas, facturas |
| PP | AFKO, AFPO, AFVC | Órdenes producción |
| WM/EWM | LTAK, LTAP, /SCWM/* | Tareas de almacén |
| QM | QALS | Lotes de inspección |
| Maestros | MARA, MARC, MBEW, LFA1, LFB1, KNA1, KNB1 | Material, proveedor, cliente |

Cualquier endpoint fuera de esta lista es rechazado en el cliente SAP antes de salir del backend.

## Configuración esperada

`.env` (Fase 4):
```
SAP_BASE_URL=https://my-s4-system.ondemand.com
SAP_CLIENT=100
SAP_USER=AMS_AGENT_RO
SAP_PASSWORD=...
SAP_READONLY_ENABLED=true
SAP_DEFAULT_TOP=50
```

`SAP_USER` debe tener únicamente **roles de consulta**. La validación de autorizaciones es responsabilidad del sistema SAP, no del agente — pero el agente respeta el catálogo blanco como segunda capa.

## Tool use de Claude

Cuando RAG y SAP estén activos:
- El backend declara herramientas a Claude vía `tools` (Anthropic tool use).
- Claude decide cuándo invocar `sap_read_purchase_order`, `sap_read_sales_order`, etc.
- El backend ejecuta la herramienta y devuelve el resultado.
- Claude integra el dato en la respuesta y agrega el bloque 13.

## Logging

- Cada consulta SAP se registra en `audit_logs` con `action="SAP_READ_REQUEST"` y detalle del endpoint + parámetros (sin PII).
- Respuesta SAP NO se loggea en texto plano si contiene PII; solo conteo de filas y campos no sensibles.

## Lo que NO se permitirá

- BAPI/RFC de creación, modificación, anulación.
- Llamadas masivas sin filtros.
- Consultas a tablas de precios confidenciales o contratos sin autorización explícita.
- Operaciones en productivo sin un control de cambios externo aprobado.
