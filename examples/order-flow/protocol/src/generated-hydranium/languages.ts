/******************************************************************************
 * Generated from the Langium language metadata — DO NOT EDIT MANUALLY!
 * Run: npm --prefix examples/order-flow/server run generate:transfer-model
 ******************************************************************************/

export const DOMAIN_LANGUAGE = { languageId: "order-flow-domain", fileExtensions: [".domain"] } as const;
export const LAYOUT_LANGUAGE = { languageId: "order-flow-layout", fileExtensions: [".layout"] } as const;
export const PROCESS_LANGUAGE = { languageId: "order-flow-process", fileExtensions: [".process"] } as const;

/** Every language of the project, in the order langium-cli declares them. */
export const ALL_LANGUAGES = [DOMAIN_LANGUAGE, LAYOUT_LANGUAGE, PROCESS_LANGUAGE] as const;
