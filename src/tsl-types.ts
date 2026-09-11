import type { Color, Node, UniformNode, Vector3, Vector4 } from 'three/webgpu';
import type { storage } from 'three/tsl';

/**
 * `@types/three` types TSL structurally, which makes the inferred types of
 * `uniform()` and friends unwieldy to spell out inline. These aliases keep the
 * signatures in this project readable.
 */
export type FloatUniform = UniformNode<'float', number>;
export type UintUniform = UniformNode<'uint', number>;
export type Vec3Uniform = UniformNode<'vec3', Vector3>;
export type ColorUniform = UniformNode<'color', Color>;
export type Vec4Uniform = UniformNode<'vec4', Vector4>;

export type Vec2Node = Node<'vec2'>;
export type Vec3Node = Node<'vec3'>;
export type FloatNode = Node<'float'>;
export type UintNode = Node<'uint'>;

/**
 * The storage buffers `instancedArray` and `storage` hand back. `@types/three`
 * does not export the node type itself, but `storage` is declared generic over
 * its element type, so instantiating it names the buffer without reaching into
 * three's internals.
 */
export type Vec2Buffer = ReturnType<typeof storage<'vec2'>>;
export type Vec3Buffer = ReturnType<typeof storage<'vec3'>>;
export type Vec4Buffer = ReturnType<typeof storage<'vec4'>>;
