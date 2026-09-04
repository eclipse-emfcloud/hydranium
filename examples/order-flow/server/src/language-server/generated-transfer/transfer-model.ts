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
export const BranchType = 'Branch';
export const DiagramNodeType = 'DiagramNode';
export const DomainModelType = 'DomainModel';
export const EntityType = 'Entity';
export const EnumLiteralType = 'EnumLiteral';
export const EnumerationType = 'Enumeration';
export const FieldType = 'Field';
export const GatewayType = 'Gateway';
export const LayoutModelType = 'LayoutModel';
export const ProcessModelType = 'ProcessModel';
export const ProjectManifestType = 'ProjectManifest';
export const ReadType = 'Read';
export const TaskType = 'Task';
export const TransitionType = 'Transition';
export const TypeReferenceType = 'TypeReference';
export const ValueTypeType = 'ValueType';
export const WriteType = 'Write';

// --- Type Aliases ---
export type OrderFlowKeywordNames = ',' | '-' | ':' | '[' | ']' | 'entity' | 'enum' | 'project' | 'public' | 'requires' | 'valuetype' | '{' | '}' | 'at' | 'for' | 'layout' | 'node' | 'size' | '->' | '.' | '=' | 'gateway' | 'process' | 'reads' | 'task' | 'transition' | 'writes';
export const OrderFlowKeywordNamesValues = [',', '-', ':', '[', ']', 'entity', 'enum', 'project', 'public', 'requires', 'valuetype', '{', '}', 'at', 'for', 'layout', 'node', 'size', '->', '.', '=', 'gateway', 'process', 'reads', 'task', 'transition', 'writes'] as const;
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
   readonly $type: typeof BranchType;
   label: string;
   target: Reference<FlowNode>;
}

export interface DiagramNode extends OrderFlowElement {
   readonly $type: typeof DiagramNodeType;
   flowNode: Reference<FlowNode>;
   height?: number;
   width?: number;
   x: number;
   y: number;
}

export interface DomainModel extends OrderFlowElement {
   readonly $type: typeof DomainModelType;
   declarations: Array<Declaration>;
   project?: ProjectManifest;
}

export interface Entity extends OrderFlowElement {
   readonly $type: typeof EntityType;
   fields: Array<Field>;
   name: string;
   visibility?: Visibility;
}

export interface EnumLiteral extends OrderFlowElement {
   readonly $type: typeof EnumLiteralType;
   name: string;
}

export interface Enumeration extends OrderFlowElement {
   readonly $type: typeof EnumerationType;
   literals: Array<EnumLiteral>;
   name: string;
   visibility?: Visibility;
}

export interface Field extends OrderFlowElement {
   readonly $type: typeof FieldType;
   many: boolean;
   name: string;
   type: TypeReference;
}

export interface Gateway extends OrderFlowElement {
   readonly $type: typeof GatewayType;
   branches: Array<Branch>;
   name: string;
}

export interface LayoutModel extends OrderFlowElement {
   readonly $type: typeof LayoutModelType;
   name: string;
   nodes: Array<DiagramNode>;
   process: Reference<ProcessModel>;
}

export interface ProcessModel extends OrderFlowElement {
   readonly $type: typeof ProcessModelType;
   name: string;
   nodes: Array<FlowNode>;
   subject: Reference<Entity>;
   transitions: Array<Transition>;
}

export interface ProjectManifest extends OrderFlowElement {
   readonly $type: typeof ProjectManifestType;
   dependencies: Array<ProjectName>;
   name: ProjectName;
}

export interface Read extends OrderFlowElement {
   readonly $type: typeof ReadType;
   entity: Reference<Entity>;
   field: Reference<Field>;
}

export interface Task extends OrderFlowElement {
   readonly $type: typeof TaskType;
   effects: Array<Effect>;
   name: string;
   /** @derived The `.domain` fields this task's write effects resolve to, in effect order. */
   readonly _writtenFields?: Field[];
   /** @derived One-line rendering of the task's effects, e.g. `writes status=PAID (OrderStatus)`. */
   readonly _effectSummary?: string;
}

export interface Transition extends OrderFlowElement {
   readonly $type: typeof TransitionType;
   source: Reference<FlowNode>;
   target: Reference<FlowNode>;
}

export interface TypeReference extends OrderFlowElement {
   readonly $type: typeof TypeReferenceType;
   declared: Reference<Declaration>;
}

export interface ValueType extends OrderFlowElement {
   readonly $type: typeof ValueTypeType;
   fields: Array<Field>;
   name: string;
   visibility?: Visibility;
}

export interface Write extends OrderFlowElement {
   readonly $type: typeof WriteType;
   entity: Reference<Entity>;
   field: Reference<Field>;
   literal: Reference<EnumLiteral>;
}

// --- Type Guards ---
export function isOrderFlowElement(item: unknown): item is OrderFlowElement {
   return !!item && typeof item === 'object' && '$type' in item && typeof (item as OrderFlowElement).$type === 'string';
}

export function isBranch(item: unknown): item is Branch {
   return isOrderFlowElement(item) && item.$type === BranchType;
}

export function isDiagramNode(item: unknown): item is DiagramNode {
   return isOrderFlowElement(item) && item.$type === DiagramNodeType;
}

export function isDomainModel(item: unknown): item is DomainModel {
   return isOrderFlowElement(item) && item.$type === DomainModelType;
}

export function isEntity(item: unknown): item is Entity {
   return isOrderFlowElement(item) && item.$type === EntityType;
}

export function isEnumLiteral(item: unknown): item is EnumLiteral {
   return isOrderFlowElement(item) && item.$type === EnumLiteralType;
}

export function isEnumeration(item: unknown): item is Enumeration {
   return isOrderFlowElement(item) && item.$type === EnumerationType;
}

export function isField(item: unknown): item is Field {
   return isOrderFlowElement(item) && item.$type === FieldType;
}

export function isGateway(item: unknown): item is Gateway {
   return isOrderFlowElement(item) && item.$type === GatewayType;
}

export function isLayoutModel(item: unknown): item is LayoutModel {
   return isOrderFlowElement(item) && item.$type === LayoutModelType;
}

export function isProcessModel(item: unknown): item is ProcessModel {
   return isOrderFlowElement(item) && item.$type === ProcessModelType;
}

export function isProjectManifest(item: unknown): item is ProjectManifest {
   return isOrderFlowElement(item) && item.$type === ProjectManifestType;
}

export function isRead(item: unknown): item is Read {
   return isOrderFlowElement(item) && item.$type === ReadType;
}

export function isTask(item: unknown): item is Task {
   return isOrderFlowElement(item) && item.$type === TaskType;
}

export function isTransition(item: unknown): item is Transition {
   return isOrderFlowElement(item) && item.$type === TransitionType;
}

export function isTypeReference(item: unknown): item is TypeReference {
   return isOrderFlowElement(item) && item.$type === TypeReferenceType;
}

export function isValueType(item: unknown): item is ValueType {
   return isOrderFlowElement(item) && item.$type === ValueTypeType;
}

export function isWrite(item: unknown): item is Write {
   return isOrderFlowElement(item) && item.$type === WriteType;
}

export function isOrderFlowKeywordNames(item: unknown): item is OrderFlowKeywordNames {
   return item === ',' || item === '-' || item === ':' || item === '[' || item === ']' || item === 'entity' || item === 'enum' || item === 'project' || item === 'public' || item === 'requires' || item === 'valuetype' || item === '{' || item === '}' || item === 'at' || item === 'for' || item === 'layout' || item === 'node' || item === 'size' || item === '->' || item === '.' || item === '=' || item === 'gateway' || item === 'process' || item === 'reads' || item === 'task' || item === 'transition' || item === 'writes';
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

