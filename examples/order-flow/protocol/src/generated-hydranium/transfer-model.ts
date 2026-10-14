/******************************************************************************
 * Generated from the Langium AST — DO NOT EDIT MANUALLY!
 * Run: npm --prefix examples/order-flow/server run generate:transfer-model
 ******************************************************************************/

/* eslint-disable */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type Reference<T> = string;

export interface OrderFlowElement {
   readonly $type: string;
}

// --- Type Constants ---
export const Branch = { $type: 'Branch', label: 'label', target: 'target' } as const;
export const Declaration = { $type: 'Declaration' } as const;
export const DiagramNode = { $type: 'DiagramNode', flowNode: 'flowNode', height: 'height', width: 'width', x: 'x', y: 'y' } as const;
export const DomainModel = { $type: 'DomainModel', declarations: 'declarations', project: 'project' } as const;
export const Effect = { $type: 'Effect' } as const;
export const Entity = { $type: 'Entity', fields: 'fields', name: 'name', visibility: 'visibility' } as const;
export const EnumLiteral = { $type: 'EnumLiteral', name: 'name' } as const;
export const Enumeration = { $type: 'Enumeration', literals: 'literals', name: 'name', visibility: 'visibility' } as const;
export const Field = { $type: 'Field', many: 'many', name: 'name', type: 'type' } as const;
export const FlowNode = { $type: 'FlowNode' } as const;
export const Gateway = { $type: 'Gateway', branches: 'branches', name: 'name' } as const;
export const LayoutModel = { $type: 'LayoutModel', nodes: 'nodes' } as const;
export const ProcessModel = { $type: 'ProcessModel', name: 'name', nodes: 'nodes', subject: 'subject', transitions: 'transitions' } as const;
export const ProjectManifest = { $type: 'ProjectManifest', dependencies: 'dependencies', name: 'name' } as const;
export const Read = { $type: 'Read', entity: 'entity', field: 'field' } as const;
export const Task = { $type: 'Task', effects: 'effects', name: 'name' } as const;
export const Transition = { $type: 'Transition', source: 'source', target: 'target' } as const;
export const TypeReference = { $type: 'TypeReference', declared: 'declared' } as const;
export const ValueType = { $type: 'ValueType', fields: 'fields', name: 'name', visibility: 'visibility' } as const;
export const Write = { $type: 'Write', entity: 'entity', field: 'field', literal: 'literal' } as const;

// --- Type Aliases ---
export type OrderFlowKeywordNames = ',' | '-' | ':' | '[' | ']' | 'entity' | 'enum' | 'project' | 'public' | 'requires' | 'valuetype' | '{' | '}' | 'at' | 'layout' | 'node' | 'size' | '->' | '.' | '=' | 'for' | 'gateway' | 'process' | 'reads' | 'task' | 'transition' | 'writes';
export const OrderFlowKeywordNamesValues = [',', '-', ':', '[', ']', 'entity', 'enum', 'project', 'public', 'requires', 'valuetype', '{', '}', 'at', 'layout', 'node', 'size', '->', '.', '=', 'for', 'gateway', 'process', 'reads', 'task', 'transition', 'writes'] as const;
export type Declaration = Entity | Enumeration | ValueType;
export type Effect = Read | Write;
export type FlowNode = Gateway | Task;
export type ProjectName = string;
export type Visibility = 'public';
export const VisibilityValues = ['public'] as const;

// --- Terminal Patterns (anchored for validation) ---
export const OrderFlowTerminals = {
   WS: /^(?:\s+)$/,
   ID: /^(?:[_a-zA-Z][\w_]*)$/,
   ML_COMMENT: /^(?:\/\*[\s\S]*?\*\/)$/,
   SL_COMMENT: /^(?:\/\/[^\n\r]*)$/,
   NUMBER: /^(?:-?[0-9]+(\.[0-9]+)?)$/,
};

// --- Interfaces ---
export interface Branch extends OrderFlowElement {
   readonly $type: 'Branch';
   label: string;
   target: Reference<FlowNode>;
}

export interface DiagramNode extends OrderFlowElement {
   readonly $type: 'DiagramNode';
   flowNode: Reference<FlowNode>;
   height?: number;
   width?: number;
   x: number;
   y: number;
}

export interface DomainModel extends OrderFlowElement {
   readonly $type: 'DomainModel';
   declarations: Array<Declaration>;
   project?: ProjectManifest;
}

export interface Entity extends OrderFlowElement {
   readonly $type: 'Entity';
   fields: Array<Field>;
   name: string;
   visibility?: Visibility;
}

export interface EnumLiteral extends OrderFlowElement {
   readonly $type: 'EnumLiteral';
   name: string;
}

export interface Enumeration extends OrderFlowElement {
   readonly $type: 'Enumeration';
   literals: Array<EnumLiteral>;
   name: string;
   visibility?: Visibility;
}

export interface Field extends OrderFlowElement {
   readonly $type: 'Field';
   many: boolean;
   name: string;
   type: TypeReference;
}

export interface Gateway extends OrderFlowElement {
   readonly $type: 'Gateway';
   branches: Array<Branch>;
   name: string;
}

export interface LayoutModel extends OrderFlowElement {
   readonly $type: 'LayoutModel';
   nodes: Array<DiagramNode>;
}

export interface ProcessModel extends OrderFlowElement {
   readonly $type: 'ProcessModel';
   name: string;
   nodes: Array<FlowNode>;
   subject: Reference<Entity>;
   transitions: Array<Transition>;
}

export interface ProjectManifest extends OrderFlowElement {
   readonly $type: 'ProjectManifest';
   dependencies: Array<ProjectName>;
   name: ProjectName;
}

export interface Read extends OrderFlowElement {
   readonly $type: 'Read';
   entity: Reference<Entity>;
   field: Reference<Field>;
}

export interface Task extends OrderFlowElement {
   readonly $type: 'Task';
   effects: Array<Effect>;
   name: string;
   /** @derived The `.domain` fields this task's write effects resolve to, in effect order. */
   readonly _writtenFields?: Field[];
   /** @derived One-line rendering of the task's effects, e.g. `writes status=PAID (OrderStatus)`. */
   readonly _effectSummary?: string;
}

export interface Transition extends OrderFlowElement {
   readonly $type: 'Transition';
   source: Reference<FlowNode>;
   target: Reference<FlowNode>;
}

export interface TypeReference extends OrderFlowElement {
   readonly $type: 'TypeReference';
   declared: Reference<Declaration>;
}

export interface ValueType extends OrderFlowElement {
   readonly $type: 'ValueType';
   fields: Array<Field>;
   name: string;
   visibility?: Visibility;
}

export interface Write extends OrderFlowElement {
   readonly $type: 'Write';
   entity: Reference<Entity>;
   field: Reference<Field>;
   literal: Reference<EnumLiteral>;
}

// --- Type Guards ---
export function isOrderFlowElement(item: unknown): item is OrderFlowElement {
   return !!item && typeof item === 'object' && '$type' in item && typeof (item as OrderFlowElement).$type === 'string';
}

export function isBranch(item: unknown): item is Branch {
   return isOrderFlowElement(item) && item.$type === 'Branch';
}

export function isDiagramNode(item: unknown): item is DiagramNode {
   return isOrderFlowElement(item) && item.$type === 'DiagramNode';
}

export function isDomainModel(item: unknown): item is DomainModel {
   return isOrderFlowElement(item) && item.$type === 'DomainModel';
}

export function isEntity(item: unknown): item is Entity {
   return isOrderFlowElement(item) && item.$type === 'Entity';
}

export function isEnumLiteral(item: unknown): item is EnumLiteral {
   return isOrderFlowElement(item) && item.$type === 'EnumLiteral';
}

export function isEnumeration(item: unknown): item is Enumeration {
   return isOrderFlowElement(item) && item.$type === 'Enumeration';
}

export function isField(item: unknown): item is Field {
   return isOrderFlowElement(item) && item.$type === 'Field';
}

export function isGateway(item: unknown): item is Gateway {
   return isOrderFlowElement(item) && item.$type === 'Gateway';
}

export function isLayoutModel(item: unknown): item is LayoutModel {
   return isOrderFlowElement(item) && item.$type === 'LayoutModel';
}

export function isProcessModel(item: unknown): item is ProcessModel {
   return isOrderFlowElement(item) && item.$type === 'ProcessModel';
}

export function isProjectManifest(item: unknown): item is ProjectManifest {
   return isOrderFlowElement(item) && item.$type === 'ProjectManifest';
}

export function isRead(item: unknown): item is Read {
   return isOrderFlowElement(item) && item.$type === 'Read';
}

export function isTask(item: unknown): item is Task {
   return isOrderFlowElement(item) && item.$type === 'Task';
}

export function isTransition(item: unknown): item is Transition {
   return isOrderFlowElement(item) && item.$type === 'Transition';
}

export function isTypeReference(item: unknown): item is TypeReference {
   return isOrderFlowElement(item) && item.$type === 'TypeReference';
}

export function isValueType(item: unknown): item is ValueType {
   return isOrderFlowElement(item) && item.$type === 'ValueType';
}

export function isWrite(item: unknown): item is Write {
   return isOrderFlowElement(item) && item.$type === 'Write';
}

export function isOrderFlowKeywordNames(item: unknown): item is OrderFlowKeywordNames {
   return item === ',' || item === '-' || item === ':' || item === '[' || item === ']' || item === 'entity' || item === 'enum' || item === 'project' || item === 'public' || item === 'requires' || item === 'valuetype' || item === '{' || item === '}' || item === 'at' || item === 'layout' || item === 'node' || item === 'size' || item === '->' || item === '.' || item === '=' || item === 'for' || item === 'gateway' || item === 'process' || item === 'reads' || item === 'task' || item === 'transition' || item === 'writes';
}

export function isDeclaration(item: unknown): item is Declaration {
   return isEntity(item) || isEnumeration(item) || isValueType(item);
}

export function isEffect(item: unknown): item is Effect {
   return isRead(item) || isWrite(item);
}

export function isFlowNode(item: unknown): item is FlowNode {
   return isGateway(item) || isTask(item);
}

export function isProjectName(item: unknown): item is ProjectName {
   return typeof item === 'string';
}

export function isVisibility(item: unknown): item is Visibility {
   return item === 'public';
}

// --- Type Map ---
export type OrderFlowTransferTypes = {
   Branch: Branch;
   Declaration: Declaration;
   DiagramNode: DiagramNode;
   DomainModel: DomainModel;
   Effect: Effect;
   Entity: Entity;
   EnumLiteral: EnumLiteral;
   Enumeration: Enumeration;
   Field: Field;
   FlowNode: FlowNode;
   Gateway: Gateway;
   LayoutModel: LayoutModel;
   ProcessModel: ProcessModel;
   ProjectManifest: ProjectManifest;
   Read: Read;
   Task: Task;
   Transition: Transition;
   TypeReference: TypeReference;
   ValueType: ValueType;
   Write: Write;
};

// --- Reflection ---
export interface OrderFlowTransferTypeMetaData {
   readonly name: string;
   readonly properties: {
      readonly [name: string]: { readonly name: string; readonly defaultValue?: unknown; readonly optional?: boolean; readonly referenceType?: string };
   };
   readonly superTypes: readonly string[];
}

export const OrderFlowTransferReflection = {
   types: {
      Branch: { name: 'Branch', properties: { label: { name: 'label' }, target: { name: 'target', referenceType: 'FlowNode' } }, superTypes: [] },
      Declaration: { name: 'Declaration', properties: {}, superTypes: [] },
      DiagramNode: { name: 'DiagramNode', properties: { flowNode: { name: 'flowNode', referenceType: 'FlowNode' }, height: { name: 'height', optional: true }, width: { name: 'width', optional: true }, x: { name: 'x' }, y: { name: 'y' } }, superTypes: [] },
      DomainModel: { name: 'DomainModel', properties: { declarations: { name: 'declarations', defaultValue: [], optional: true }, project: { name: 'project', optional: true } }, superTypes: [] },
      Effect: { name: 'Effect', properties: {}, superTypes: [] },
      Entity: { name: 'Entity', properties: { fields: { name: 'fields', defaultValue: [], optional: true }, name: { name: 'name' }, visibility: { name: 'visibility', optional: true } }, superTypes: ['Declaration'] },
      EnumLiteral: { name: 'EnumLiteral', properties: { name: { name: 'name' } }, superTypes: [] },
      Enumeration: { name: 'Enumeration', properties: { literals: { name: 'literals', defaultValue: [], optional: true }, name: { name: 'name' }, visibility: { name: 'visibility', optional: true } }, superTypes: ['Declaration'] },
      Field: { name: 'Field', properties: { many: { name: 'many', defaultValue: false, optional: true }, name: { name: 'name' }, type: { name: 'type' } }, superTypes: [] },
      FlowNode: { name: 'FlowNode', properties: {}, superTypes: [] },
      Gateway: { name: 'Gateway', properties: { branches: { name: 'branches', defaultValue: [], optional: true }, name: { name: 'name' } }, superTypes: ['FlowNode'] },
      LayoutModel: { name: 'LayoutModel', properties: { nodes: { name: 'nodes', defaultValue: [], optional: true } }, superTypes: [] },
      ProcessModel: { name: 'ProcessModel', properties: { name: { name: 'name' }, nodes: { name: 'nodes', defaultValue: [], optional: true }, subject: { name: 'subject', referenceType: 'Entity' }, transitions: { name: 'transitions', defaultValue: [], optional: true } }, superTypes: [] },
      ProjectManifest: { name: 'ProjectManifest', properties: { dependencies: { name: 'dependencies', defaultValue: [], optional: true }, name: { name: 'name' } }, superTypes: [] },
      Read: { name: 'Read', properties: { entity: { name: 'entity', referenceType: 'Entity' }, field: { name: 'field', referenceType: 'Field' } }, superTypes: ['Effect'] },
      Task: { name: 'Task', properties: { effects: { name: 'effects', defaultValue: [], optional: true }, name: { name: 'name' } }, superTypes: ['FlowNode'] },
      Transition: { name: 'Transition', properties: { source: { name: 'source', referenceType: 'FlowNode' }, target: { name: 'target', referenceType: 'FlowNode' } }, superTypes: [] },
      TypeReference: { name: 'TypeReference', properties: { declared: { name: 'declared', referenceType: 'Declaration' } }, superTypes: [] },
      ValueType: { name: 'ValueType', properties: { fields: { name: 'fields', defaultValue: [], optional: true }, name: { name: 'name' }, visibility: { name: 'visibility', optional: true } }, superTypes: ['Declaration'] },
      Write: { name: 'Write', properties: { entity: { name: 'entity', referenceType: 'Entity' }, field: { name: 'field', referenceType: 'Field' }, literal: { name: 'literal', referenceType: 'EnumLiteral' } }, superTypes: ['Effect'] },
   } as const satisfies { readonly [type: string]: OrderFlowTransferTypeMetaData },

   getAllTypes(): string[] {
      return Object.keys(this.types);
   },

   getTypeMetaData(type: string): OrderFlowTransferTypeMetaData {
      return Object.prototype.hasOwnProperty.call(this.types, type)
         ? (this.types as { readonly [type: string]: OrderFlowTransferTypeMetaData })[type]
         : { name: type, properties: {}, superTypes: [] };
   },

   isSubtype(subtype: string, supertype: string): boolean {
      return subtype === supertype || this.getTypeMetaData(subtype).superTypes.some(type => this.isSubtype(type, supertype));
   },

   getAllSubTypes(type: string): string[] {
      return this.getAllTypes().filter(candidate => this.isSubtype(candidate, type));
   },

   isInstance(item: unknown, type: string): boolean {
      return isOrderFlowElement(item) && this.isSubtype(item.$type, type);
   }
};

